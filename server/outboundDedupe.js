/**
 * Evita enviar o mesmo texto ao candidato em janela curta (réplicas do scheduler / race).
 */

import { fetchRecentChatRows } from './historyStore.js'

function normalizeOutboundText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveDedupeSec(env) {
  const n = Number(env.WHATSAPP_OUTBOUND_DEDUPE_SEC)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 180
}

/**
 * @returns {{ skip: boolean, reason?: string }}
 */
export async function shouldSkipDuplicateOutbound(env, telefone, text) {
  const body = normalizeOutboundText(text)
  if (!body || body.length < 12) return { skip: false }

  const rows = await fetchRecentChatRows(env, telefone, 8)
  if (!rows.length) return { skip: false }

  const cutoff = Date.now() - resolveDedupeSec(env) * 1000
  for (const row of rows) {
    const bot = normalizeOutboundText(row?.bot_message)
    if (!bot) continue
    const at = Date.parse(row?.created_at)
    if (Number.isNaN(at) || at < cutoff) continue
    if (bot === body) {
      return { skip: true, reason: 'identical_recent_bot_message' }
    }
    if (body.length >= 40 && bot.length >= 40 && bot.slice(0, 40) === body.slice(0, 40)) {
      return { skip: true, reason: 'prefix_match_recent_bot_message' }
    }
  }
  return { skip: false }
}
