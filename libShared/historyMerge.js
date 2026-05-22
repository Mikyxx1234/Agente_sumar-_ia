/**
 * Funde histórico n8n_chat_histories + chat_messages (evita perder turnos recentes).
 */

function historyKey(m) {
  const role = m?.role === 'user' ? 'u' : 'a'
  const content = String(m?.content || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .toLowerCase()
  return `${role}:${content}`
}

/**
 * @param {Array<{role:string,content:string}>} primary
 * @param {Array<{role:string,content:string}>} supplemental
 * @returns {Array<{role:string,content:string}>}
 */
export function mergeHistoriesDedupe(primary = [], supplemental = []) {
  if (!supplemental.length) return [...primary]
  if (!primary.length) return [...supplemental]
  const seen = new Set(primary.map(historyKey))
  const out = [...primary]
  for (const m of supplemental) {
    const k = historyKey(m)
    if (!seen.has(k)) {
      out.push(m)
      seen.add(k)
    }
  }
  return out
}

/**
 * Mantém as últimas N mensagens (pares user/assistant).
 */
export function trimHistoryTail(messages, maxMessages = 16) {
  const list = Array.isArray(messages) ? messages : []
  if (list.length <= maxMessages) return list
  return list.slice(-maxMessages)
}
