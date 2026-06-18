/**
 * Evita enviar o mesmo texto ao candidato em janela curta (réplicas do scheduler / race).
 */

import { fetchRecentChatRows } from './historyStore.js'
import { normalizeTelefone, telefoneToWhatsAppJid } from './dadosClienteStore.js'
import { isPostFormRegistradoBoilerplate } from './dadosClienteInscricaoFields.js'
import { listLeadNotes } from './kommoClient.js'

/** Evita dois sendMessageWithNote simultâneos no mesmo processo. */
const inflightOutbound = new Map()

/** Mesmo sufixo que sendMessageWithNote grava no Kommo (EX-YYMMDD-HHMM-NNN). */
const AGENT_OUTBOUND_SUFFIX = /\s-\sEX-\d{6}-\d{4}-\d{3}(-[a-f0-9]+)?\s*$/i

async function fetchRecentBotRowsFromMemory(env, telefone, limit = 10) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
  if (!url || !key) return []
  const digits = normalizeTelefone(telefone)
  if (!digits) return []
  const sessionId = telefoneToWhatsAppJid(digits.startsWith('55') ? digits : `55${digits}`)
  const table = env.N8N_MEMORY_TABLE || 'n8n_chat_histories'
  const q =
    `${encodeURIComponent(table)}?session_id=eq.${encodeURIComponent(sessionId)}` +
    `&select=message,created_at,id&order=id.desc&limit=${Math.min(30, limit * 3)}`
  try {
    const r = await fetch(`${url}/rest/v1/${q}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    if (!r.ok) return []
    const rows = await r.json()
    if (!Array.isArray(rows)) return []
    const out = []
    for (const row of rows) {
      const m = row?.message
      const type = m?.type || m?.data?.type || m?.role
      if (type !== 'ai' && type !== 'assistant') continue
      const content =
        (typeof m?.data?.content === 'string' && m.data.content) ||
        (typeof m?.content === 'string' && m.content) ||
        ''
      if (!String(content).trim()) continue
      out.push({
        bot_message: String(content).trim(),
        created_at: row.created_at || new Date().toISOString(),
      })
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}

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

function resolveKommoDedupeMs(env) {
  const hours = Number(env.WHATSAPP_KOMMO_DEDUPE_HOURS)
  if (Number.isFinite(hours) && hours > 0) return Math.floor(hours * 3600 * 1000)
  return 6 * 60 * 60 * 1000
}

/** Evita reenvio quando já existe nota Kommo recente com sufixo EX- e texto similar. */
async function shouldSkipSimilarKommoOutbound(env, leadId, body) {
  const lid = Number(leadId)
  if (!Number.isFinite(lid) || lid <= 0 || !body) return { skip: false }
  const notesRes = await listLeadNotes(env, lid, { limit: 12 })
  if (!notesRes.ok) return { skip: false }
  const cutoff = Date.now() - resolveKommoDedupeMs(env)
  for (const n of notesRes.notes || []) {
    const raw = String(n?.params?.text || n?.params?.message || '').trim()
    if (!raw || !AGENT_OUTBOUND_SUFFIX.test(raw)) continue
    const at = Number(n?.created_at) * 1000
    if (!Number.isFinite(at) || at < cutoff) continue
    const bot = normalizeOutboundText(raw)
    if (!bot) continue
    if (bot === body) {
      return { skip: true, reason: 'kommo_identical_recent' }
    }
    if (body.length >= 40 && bot.length >= 40 && bot.slice(0, 40) === body.slice(0, 40)) {
      return { skip: true, reason: 'kommo_prefix_match_recent' }
    }
    if (body.length >= 60 && bot.length >= 60 && tokenOverlapRatio(body, bot) >= 0.42) {
      return { skip: true, reason: 'kommo_similar_recent' }
    }
  }
  return { skip: false }
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
 * Resultado do gate de envio.
 *
 * - `race: true` significa que `tryReserveOutboundSync` falhou (outro envio
 *   concorrente para o mesmo telefone no mesmo processo). NÃO é uma
 *   duplicata — a mensagem ainda precisa ir; o caller deve registrar erro
 *   e deixar o próximo tick do scheduler reprocessar.
 * - `race: false` (default) com `skip: true` é dedupe legítimo (mensagem
 *   idêntica/similar já enviada no `chat_messages` recente).
 *
 * @returns {{ skip: boolean, reason?: string, race?: boolean }}
 */
export async function shouldSkipDuplicateOutbound(env, telefone, text, opts = {}) {
  if (!tryReserveOutboundSync(telefone)) {
    return { skip: true, reason: 'outbound_inflight_sync', race: true }
  }
  const body = normalizeOutboundText(text)
  if (!body || body.length < 12) return { skip: false }

  const freshUserTurn = Boolean(opts.freshUserTurn)

  const releaseIfSkip = (result) => {
    if (result.skip) releaseOutboundSync(telefone)
    return result
  }

  const { leadId } = opts
  if (leadId != null && leadId !== '' && !freshUserTurn) {
    const kommo = await shouldSkipSimilarKommoOutbound(env, leadId, body)
    if (kommo.skip) return releaseIfSkip(kommo)
  }

  const rows = await fetchRecentChatRows(env, telefone, 10)
  const memoryRows =
    rows.length > 0 ? [] : await fetchRecentBotRowsFromMemory(env, telefone, 10)
  const allRows = rows.length > 0 ? rows : memoryRows
  if (!allRows.length) return { skip: false }

  const dedupeCutoff = Date.now() - resolveDedupeSec(env) * 1000
  const cooldownCutoff = Date.now() - resolveCooldownSec(env) * 1000
  let botsInCooldownWindow = 0

  for (const row of allRows) {
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

    if (freshUserTurn) continue

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

  if (!freshUserTurn && botsInCooldownWindow >= 2) {
    return releaseIfSkip({ skip: true, reason: 'multiple_recent_bot_replies' })
  }

  return { skip: false }
}
