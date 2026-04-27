/**
 * Cache em memória do último wamid recebido por sessão (JID).
 *
 * Pra que serve: o typing indicator da Cloud API exige passar o `message_id`
 * (wamid) de uma mensagem recebida do cliente nas últimas 24h. Como a gente
 * faz debounce de 15s, o wamid que o webhook acabou de receber é o melhor
 * candidato pra usar quando o flush dispara o "digitando...".
 *
 * Se a Evolution estiver em modo Baileys, o `data.key.id` não é um wamid
 * válido pra Cloud API — nesse caso a gente cai no fallback (Evolution
 * presence). Por isso aqui a gente só armazena o que parece um wamid.
 *
 * TTL: 23h (margem antes do limite de 24h da Cloud API).
 */

const TTL_MS = 23 * 60 * 60 * 1000
const store = new Map() // sessionId -> { wamid, ts }

function isLikelyWamid(id) {
  if (!id) return false
  const s = String(id)
  // wamids da Cloud API começam com "wamid." (URL-safe base64). Em modo
  // Cloud API, a Evolution costuma forwardar exatamente esse valor no
  // data.key.id. Se NÃO começar com wamid., é provavelmente um stanza
  // id do Baileys e não vai funcionar na Cloud API.
  return s.startsWith('wamid.') || s.startsWith('wamid_')
}

export function rememberWamid(sessionId, messageId) {
  if (!sessionId || !isLikelyWamid(messageId)) return false
  store.set(sessionId, { wamid: String(messageId), ts: Date.now() })
  return true
}

export function getWamid(sessionId) {
  if (!sessionId) return null
  const entry = store.get(sessionId)
  if (!entry) return null
  if (Date.now() - entry.ts > TTL_MS) {
    store.delete(sessionId)
    return null
  }
  return entry.wamid
}

export function forgetWamid(sessionId) {
  if (sessionId) store.delete(sessionId)
}

export function _resetForTests() {
  store.clear()
}
