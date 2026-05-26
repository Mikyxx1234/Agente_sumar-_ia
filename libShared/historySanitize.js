/**
 * Remove ruído do histórico injetado no orquestrador (scheduler, pós-form, promessas vazias de formulário).
 */

const POST_FORM_ASSISTANT_PREFIXES = [
  'obrigado! recebemos seu formul',
  'obrigado! registramos o formul',
  'um consultor da faculdade sumaré entrará em contato',
]

/** Mensagem do assistente que só promete envio sem confirmar entrega (alucinação comum). */
export function isAssistantFormSendPromiseOnly(text) {
  const t = String(text || '')
    .replace(/\s-\s+EX-\d{6}-\d{4}-\d{3}(-[a-f0-9]+)?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t || !/\bformul[aá]rio\b/i.test(t)) return false
  if (/\b(acabei de enviar|já enviei|já ativei|confira a mensagem com o botão)\b/i.test(t)) return false
  return /\b(vou enviar|vou mandar|vou preparar|pode aguardar|aguarde um momento|em instantes)\b/i.test(t)
}

export function isAssistantHistoryNoise(text) {
  const c = String(text || '').trim()
  if (!c || c.length < 2) return true
  if (/^\[(scheduler|system|legenda|áudio|audio|imagem|mensagem)\]/i.test(c)) return true
  if (/\[scheduler\]/i.test(c)) return true
  if (/^\[scheduler\]/i.test(c)) return true
  const lower = c.toLowerCase()
  if (POST_FORM_ASSISTANT_PREFIXES.some((p) => lower.startsWith(p))) return true
  if (isAssistantFormSendPromiseOnly(c)) return true
  return false
}

/** Filtra turnos user/assistant usados nas heurísticas de inscrição e no orquestrador. */
export function filterHistoryMessagesForAgent(messages) {
  return (messages || []).filter((m) => {
    const c = String(m?.content || '').trim()
    if (!c || c.length < 2) return false
    if (m.role === 'system') return false
    if (m.role === 'user' && (/^\[(scheduler|system)\]/i.test(c) || /\[scheduler\]/i.test(c))) return false
    if (m.role === 'assistant' && isAssistantHistoryNoise(c)) return false
    return true
  })
}
