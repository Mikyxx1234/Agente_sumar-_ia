/**
 * Funde histórico n8n_chat_histories + chat_messages (evita perder turnos recentes).
 * Também prioriza CRM (EduIT) quando o histórico remoto está denso o bastante.
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

function messageAtMs(m) {
  if (!m || m.at == null) return null
  if (typeof m.at === 'number' && Number.isFinite(m.at)) {
    return m.at < 1e12 ? Math.round(m.at * 1000) : Math.round(m.at)
  }
  if (m.at instanceof Date) {
    const t = m.at.getTime()
    return Number.isFinite(t) ? t : null
  }
  const t = Date.parse(String(m.at))
  return Number.isFinite(t) ? t : null
}

function filterUsableMessages(list) {
  return (Array.isArray(list) ? list : []).filter((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false
    return String(m.content || '').trim().length > 0
  })
}

function dedupePreserveOrder(messages) {
  const seen = new Set()
  const out = []
  for (const m of messages) {
    const k = historyKey(m)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(m)
  }
  return out
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

/**
 * Merge priorizado CRM (EduIT) + Supabase (chat_messages / n8n).
 *
 * - CRM >= minExclusiveTurns → só CRM (filtro/dedupe/tail), exclusiveEduit:true
 * - CRM thin → prefixa chat com at < primeiro CRM; dedupe assimétrico CRM > chat > n8n;
 *   n8n sem timestamp entra no prefixo só se chave inédita
 * - Sem CRM → semanticamente igual a mergeHistoriesDedupe(n8n, chat) + trim
 *
 * @returns {{ messages:Array, exclusiveEduit:boolean, counts:object }}
 */
export function mergeCrmAndSupabaseHistories(
  { crmMsgs = [], chatMsgs = [], n8nMsgs = [] } = {},
  { minExclusiveTurns = 4, maxTail = 16 } = {},
) {
  const crm = filterUsableMessages(crmMsgs)
  const chat = filterUsableMessages(chatMsgs)
  const n8n = filterUsableMessages(n8nMsgs)
  const limiar = Math.max(1, Number(minExclusiveTurns) || 4)
  const tail = Math.max(1, Number(maxTail) || 16)

  const countsBase = {
    crm: crm.length,
    chat: chat.length,
    n8n: n8n.length,
  }

  if (crm.length >= limiar) {
    const messages = trimHistoryTail(dedupePreserveOrder(crm), tail)
    return {
      messages,
      exclusiveEduit: true,
      counts: { ...countsBase, merged: messages.length },
    }
  }

  if (crm.length === 0) {
    const messages = trimHistoryTail(mergeHistoriesDedupe(n8n, chat), tail)
    return {
      messages,
      exclusiveEduit: false,
      counts: { ...countsBase, merged: messages.length },
    }
  }

  // CRM thin: CRM é âncora; chat anterior ao primeiro CRM; n8n sem ts só se chave inédita
  const crmKeys = new Set(crm.map(historyKey))
  const firstCrmAt = crm.reduce((min, m) => {
    const t = messageAtMs(m)
    if (t == null) return min
    return min == null ? t : Math.min(min, t)
  }, null)

  const chatPrefix = []
  for (const m of chat) {
    const k = historyKey(m)
    if (crmKeys.has(k)) continue
    const t = messageAtMs(m)
    if (firstCrmAt != null) {
      if (t == null || t >= firstCrmAt) continue
    }
    chatPrefix.push(m)
  }

  const seen = new Set([...crmKeys, ...chatPrefix.map(historyKey)])
  const n8nPrefix = []
  for (const m of n8n) {
    const k = historyKey(m)
    if (seen.has(k)) continue
    const t = messageAtMs(m)
    if (t != null) {
      // com timestamp: só entra no prefixo se anterior ao primeiro CRM
      if (firstCrmAt != null && t >= firstCrmAt) continue
      n8nPrefix.push(m)
      seen.add(k)
      continue
    }
    // sem timestamp: entra antes apenas se chave inédita
    n8nPrefix.push(m)
    seen.add(k)
  }

  // Ordem: n8n prefix (novos) → chat prefix → CRM (autoridade no overlap)
  // Dedupe assimétrico já aplicado via seen (CRM > chat > n8n na construção)
  const merged = trimHistoryTail(dedupePreserveOrder([...n8nPrefix, ...chatPrefix, ...crm]), tail)
  return {
    messages: merged,
    exclusiveEduit: false,
    counts: { ...countsBase, merged: merged.length },
  }
}
