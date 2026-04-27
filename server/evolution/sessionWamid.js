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
const MAX_PER_SESSION = 25
// sessionId -> Array<{ wamid, ts }>. Mais recentes no fim.
const store = new Map()

function isLikelyWamid(id) {
  if (!id) return false
  const s = String(id)
  // wamids da Cloud API começam com "wamid." (URL-safe base64). Em modo
  // Cloud API, a Evolution costuma forwardar exatamente esse valor no
  // data.key.id. Se NÃO começar com wamid., é provavelmente um stanza
  // id do Baileys e não vai funcionar na Cloud API.
  return s.startsWith('wamid.') || s.startsWith('wamid_')
}

function pruneExpired(arr) {
  const cutoff = Date.now() - TTL_MS
  return arr.filter((e) => e.ts >= cutoff)
}

export function rememberWamid(sessionId, messageId) {
  if (!sessionId || !isLikelyWamid(messageId)) return false
  const arr = pruneExpired(store.get(sessionId) || [])
  if (!arr.some((e) => e.wamid === messageId)) {
    arr.push({ wamid: String(messageId), ts: Date.now() })
  }
  while (arr.length > MAX_PER_SESSION) arr.shift()
  store.set(sessionId, arr)
  return true
}

/** Wamid mais recente da sessão (compat com versão anterior). */
export function getWamid(sessionId) {
  const list = getWamids(sessionId)
  return list.length ? list[list.length - 1] : null
}

/**
 * Lista de wamids da sessão, mais recentes primeiro.
 * A Meta tipicamente só aceita typing+read nos wamids dos últimos minutos;
 * ter vários permite ciclar e estender o "digitando..." via heartbeat.
 */
export function getWamids(sessionId) {
  if (!sessionId) return []
  const arr = pruneExpired(store.get(sessionId) || [])
  if (arr.length !== (store.get(sessionId) || []).length) {
    if (arr.length === 0) store.delete(sessionId)
    else store.set(sessionId, arr)
  }
  return arr.slice().reverse().map((e) => e.wamid)
}

export function forgetWamid(sessionId) {
  if (sessionId) store.delete(sessionId)
}

export function _resetForTests() {
  store.clear()
}
