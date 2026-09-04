/**
 * Link de pagamento da matrícula (portal Softsy / educsy).
 * Usado para decidir se o card deve ir para a fila Aguardando pagamento.
 */

export function looksLikeMatriculaPagamentoUrl(text) {
  const raw = String(text || '')
  if (!raw) return false
  if (/matricula\.sumare\.edu\.br/i.test(raw)) return true
  if (/\/vestibular\/pagamento/i.test(raw)) return true
  return false
}

/** Linha do Supabase indica que o link de pagamento já foi gerado/enviado. */
export function rowHasPagamentoLinkEnviado(row) {
  if (!row || typeof row !== 'object') return false
  if (looksLikeMatriculaPagamentoUrl(row.captacao_contrato_link)) return true
  const at = String(row.captacao_contrato_link_at || '').trim()
  const candidato = String(row.captacao_candidato_id || '').trim()
  return Boolean(at && candidato)
}

export function historyHasPagamentoLink(messages) {
  for (const m of messages || []) {
    if (looksLikeMatriculaPagamentoUrl(m?.content)) return true
  }
  return false
}
