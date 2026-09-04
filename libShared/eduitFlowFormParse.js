/**
 * Retorno do WhatsApp Flow no EduIT (chat / nota).
 * Formatos vistos em produção:
 *   📋 *Resposta do formulário* — _flow_ *Nome* ↳ … *CPF* ↳ …
 *   FORMULÁRIO flow 6 campos / Nome ↳ … / Email ↳ …
 */

const HEADER_RE =
  /resposta do formul[aá]rio|formul[aá]rio\s+flow|📋\s*\*?\s*resposta/i

function pickLabeled(raw, label) {
  const re = new RegExp(
    `(?:\\*?\\s*${label}\\s*\\*?)\\s*(?:↳|:|–|-)?\\s*([^\\n*]+)`,
    'i',
  )
  const m = String(raw || '').match(re)
  return String(m?.[1] || '')
    .replace(/^_flow_\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @returns {{ nome: string, cpf: string, email: string, data_nasc: string, sexo: string, telefone: string } | null}
 */
export function parseEduitFlowFormReply(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const looksForm = HEADER_RE.test(raw) || (/\bnome\b/i.test(raw) && /\bcpf\b/i.test(raw) && /↳/.test(raw))
  if (!looksForm) return null

  const nome = pickLabeled(raw, 'Nome')
  const cpf = pickLabeled(raw, 'CPF').replace(/\D/g, '')
  const email = pickLabeled(raw, 'E-?mail')
  const dataNasc = pickLabeled(raw, 'Data de Nascimento')
  const sexo = pickLabeled(raw, 'Sexo')
  const telefone = pickLabeled(raw, 'Telefone').replace(/\D/g, '')

  if (!nome && cpf.length !== 11 && !email) return null
  return {
    nome,
    cpf: cpf.length === 11 ? cpf : '',
    email,
    data_nasc: dataNasc,
    sexo,
    telefone,
  }
}

export function messageLooksLikeEduitFlowFormReply(text) {
  const parsed = parseEduitFlowFormReply(text)
  if (parsed && (parsed.cpf || parsed.email || (parsed.nome && parsed.data_nasc))) return true
  const raw = String(text || '')
  return HEADER_RE.test(raw) && /\b(cpf|nome|e-?mail)\b/i.test(raw)
}

/** Card EduIT já tem identidade do formulário (não exige e-mail/curso). */
export function snapshotHasFormIdentity(snapshot) {
  const nome = String(snapshot?.nome || '').trim()
  const cpf = String(snapshot?.cpf || '').replace(/\D/g, '')
  if (cpf.length !== 11) return false
  const nomeOk = nome.length >= 3 && !/^neg[oó]cio\b/i.test(nome)
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(snapshot?.email || '').trim())
  return nomeOk || emailOk
}

export function historyHasEduitFlowFormReply(historyMessages, windowSize = 12) {
  const recent = (historyMessages || []).slice(-windowSize)
  for (const m of recent) {
    if (messageLooksLikeEduitFlowFormReply(m?.content)) return true
  }
  return false
}
