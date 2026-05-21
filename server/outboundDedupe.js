/**
 * Evita enviar o mesmo texto ao candidato em janela curta (réplicas do scheduler / race).
 */

import { fetchRecentChatRows } from './historyStore.js'
import { normalizeTelefone } from './dadosClienteStore.js'
import { isPostFormRegistradoBoilerplate } from './dadosClienteInscricaoFields.js'

/** Evita dois sendMessageWithNote simultâneos no mesmo processo. */
const inflightOutbound = new Map()

/** Mesmo sufixo que sendMessageWithNote grava no Kommo (EX-YYMMDD-HHMM-NNN). */
const AGENT_OUTBOUND_SUFFIX = /\s-\sEX-\d{6}-\d{4}-\d{3}\s*$/i

function normalizeOutboundText(text) {
  return String(text || '')
    .replace(AGENT_OUTBOUND_SUFFIX, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveDedupeSec(env) {
  const n = Number(env.WHATSAPP_OUTBOUND_DEDUPE_SEC)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 180
}

function resolveCooldownSec(env) {
  const n = Number(env.AGENT_OUTBOUND_COOLDOWN_SEC)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 45
}

function tokenOverlapRatio(a, b) {
  const ta = new Set(
    String(a || '')
      .toLowerCase()
      .replace(/[^a-z0-9áàâãéêíóôõúç\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  )
  const tb = new Set(
    String(b || '')
      .toLowerCase()
      .replace(/[^a-z0-9áàâãéêíóôõúç\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  )
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const w of ta) {
    if (tb.has(w)) inter += 1
  }
  return inter / Math.min(ta.size, tb.size)
}

/**
 * Reserva envio síncrono (antes de awaits). Liberar em finally do sender.
 */
export function tryReserveOutboundSync(telefone) {
  const key = normalizeTelefone(telefone)
  if (!key) return true
  const now = Date.now()
  const cur = inflightOutbound.get(key)
  if (cur && cur > now) return false
  inflightOutbound.set(key, now + 120_000)
  return true
}

export function releaseOutboundSync(telefone) {
  const key = normalizeTelefone(telefone)
  if (key) inflightOutbound.delete(key)
}

/**
 * @returns {{ skip: boolean, reason?: string }}
 */
export async function shouldSkipDuplicateOutbound(env, telefone, text) {
  if (!tryReserveOutboundSync(telefone)) {
    return { skip: true, reason: 'outbound_inflight_sync' }
  }
  const body = normalizeOutboundText(text)
  if (!body || body.length < 12) return { skip: false }

  const releaseIfSkip = (result) => {
    if (result.skip) releaseOutboundSync(telefone)
    return result
  }

  const rows = await fetchRecentChatRows(env, telefone, 10)
  if (!rows.length) return { skip: false }

  const dedupeCutoff = Date.now() - resolveDedupeSec(env) * 1000
  const cooldownCutoff = Date.now() - resolveCooldownSec(env) * 1000
  let botsInCooldownWindow = 0

  for (const row of rows) {
    const bot = normalizeOutboundText(row?.bot_message)
    if (!bot) continue
    const at = Date.parse(row?.created_at)
    if (Number.isNaN(at)) continue

    if (at >= cooldownCutoff) botsInCooldownWindow += 1

    if (at < dedupeCutoff) continue

    if (
      isPostFormRegistradoBoilerplate(body) &&
      isPostFormRegistradoBoilerplate(bot) &&
      at >= dedupeCutoff
    ) {
      return releaseIfSkip({ skip: true, reason: 'post_form_boilerplate_recent' })
    }

    if (bot === body) {
      return releaseIfSkip({ skip: true, reason: 'identical_recent_bot_message' })
    }
    if (body.length >= 40 && bot.length >= 40 && bot.slice(0, 40) === body.slice(0, 40)) {
      return releaseIfSkip({ skip: true, reason: 'prefix_match_recent_bot_message' })
    }
    if (body.length >= 80 && bot.length >= 80 && tokenOverlapRatio(body, bot) >= 0.55) {
      return releaseIfSkip({ skip: true, reason: 'similar_recent_bot_message' })
    }
    if (at >= cooldownCutoff && body.length >= 60 && tokenOverlapRatio(body, bot) >= 0.42) {
      return releaseIfSkip({ skip: true, reason: 'similar_outbound_cooldown' })
    }
  }

  if (botsInCooldownWindow >= 2) {
    return releaseIfSkip({ skip: true, reason: 'multiple_recent_bot_replies' })
  }

  return { skip: false }
}
