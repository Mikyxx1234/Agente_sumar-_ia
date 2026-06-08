/**
 * Histórico de chat via API Amojo (Kommo) — exige segredo do canal, não usa Bearer CRM.
 *
 * @see https://developers.kommo.com/reference/chat-history
 */

import crypto from 'crypto'
import { kommoRawFetch } from './kommoRateLimiter.js'

function rfc2822KommoDate() {
  return new Date().toUTCString().replace('GMT', '+0000')
}

function md5HexLower(body) {
  return crypto.createHash('md5').update(body, 'utf8').digest('hex').toLowerCase()
}

/**
 * Ordem alinhada aos exemplos PHP oficiais: METHOD, MD5, Content-Type, Date, path.
 */
function buildAmojoSignature(secret, method, path, dateStr, contentType, md5) {
  const str = [method.toUpperCase(), md5, contentType, dateStr, path].join('\n')
  return crypto.createHmac('sha1', secret).update(str, 'utf8').digest('hex').toLowerCase()
}

/**
 * @param {Record<string,string>} env
 * @param {{ scopeId: string, conversationId: string, limit?: number, offset?: number }} p
 * @returns { Promise<{ ok: boolean, messages?: object[], error?: string, status?: number }> }
 */
export async function fetchAmojoChatHistory(env, { scopeId, conversationId, limit = 30, offset = 0 } = {}) {
  const secret = String(env.KOMMO_CHANNEL_SECRET || '').trim()
  const base = (env.KOMMO_AMOJO_BASE || 'https://amojo.kommo.com').replace(/\/$/, '')
  if (!secret || !scopeId || !conversationId) {
    return { ok: false, error: 'KOMMO_CHANNEL_SECRET, KOMMO_CHANNEL_SCOPE_ID (scope) ou chat_id ausente' }
  }
  const lim = Math.min(50, Math.max(1, Number(limit) || 30))
  const off = Math.max(0, Number(offset) || 0)
  const path = `/v2/origin/custom/${encodeURIComponent(scopeId)}/chats/${encodeURIComponent(conversationId)}/history`
  const qs = new URLSearchParams({ limit: String(lim), offset: String(off) })
  const dateStr = rfc2822KommoDate()
  const contentType = 'application/json'
  const check = md5HexLower('')
  const sig = buildAmojoSignature(secret, 'GET', path, dateStr, contentType, check)
  const url = `${base}${path}?${qs}`

  try {
    const res = await kommoRawFetch(url, {
      method: 'GET',
      headers: {
        Date: dateStr,
        'Content-Type': contentType,
        'Content-MD5': check,
        'X-Signature': sig,
        Accept: 'application/json',
      },
    })
    const raw = await res.text()
    if (res.status === 204) return { ok: true, messages: [] }
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      const err = typeof raw === 'string' ? raw.slice(0, 300) : 'erro'
      return { ok: false, status: res.status, error: err }
    }
    const messages = Array.isArray(data?.messages) ? data.messages : []
    return { ok: true, messages }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
