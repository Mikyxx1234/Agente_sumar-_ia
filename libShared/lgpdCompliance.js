/**
 * LGPD — proteção de dados pessoais de candidatos/alunos no atendimento.
 *
 * O agente só pode divulgar informações institucionais (cursos, preços, etc.).
 * Dado sensível de candidato permitido na conversa: RA (Registro Acadêmico),
 * quando legítimo e disponível para o próprio titular.
 */

import { SUMARE_POLOS_EAD } from './sumarePoloCatalog.js'

export const DEFAULT_LGPD_SENSITIVE_REFUSAL =
  'Por segurança e em conformidade com a LGPD, não posso compartilhar dados pessoais ou cadastrais de candidatos ou alunos por aqui. ' +
  'Posso ajudar com informações da Faculdade Sumaré — cursos EAD, valores, duração, matrícula e inscrição. ' +
  'Se precisar de atendimento sobre dados cadastrais, um consultor pode te ajudar com a identificação adequada.'

const CPF_FORMATTED_RX = /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/
const CPF_CONTEXT_RX = /\b(cpf|c\.p\.f\.|documento)\b[\s\S]{0,40}\b\d{3}/i
const RG_RX = /\b\d{1,2}[.\s]?\d{3}[.\s]?\d{3}[-\s]?[\dXx]\b/
const PERSONAL_EMAIL_RX =
  /\b[A-Za-z0-9._%+-]+@(gmail|hotmail|outlook|yahoo|live|icloud|uol|bol|terra|protonmail|zoho)\.[A-Za-z]{2,}\b/i
const GENERIC_EMAIL_WITH_LABEL_RX =
  /\b(e-?mail|email)\s*(do|da|de|:)?\s*[:\s]*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i
const PHONE_WITH_LABEL_RX =
  /\b(telefone|celular|whatsapp|fone)\s*(do|da|de|:)?\s*[:\s]*(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}[-\s]?\d{4}\b/i
const ADDRESS_LEAK_RX =
  /\b(endereço|endereco|rua|avenida|av\.|cep)\s*(do|da|de|:)?\s*[:\s]*.{8,}/i
/** Dados bancários do candidato — NÃO incluir "banco" solto (falso positivo em "Banco de Dados"). */
const BANK_LEAK_RX =
  /\b(cartão|cartao|conta bancária|conta bancaria|pix|agência|agencia)\s*(do|da|de|:)?\s*[:\s]*.{4,}/i
const BANK_INSTITUTION_LEAK_RX =
  /\bbanco\b(?!\s+de\s+dados\b)\s*(do|da|de)\s*(?:\w+\s+){0,3}(conta|corrente|poupan[cç]a|ag[eê]ncia|pix)\b/i
/** Curso tecnólogo — remover antes do guard financeiro para não confundir com "banco do lead". */
const CURSO_BANCO_DE_DADOS_RX = /\bbanco\s+de\s+dados\b/gi
const THIRD_PARTY_DATA_REQUEST_RX =
  /\b(cpf|e-?mail|email|telefone|celular|whatsapp|endereço|endereco|dados|informações|informacoes|cadastro|matrícula|matricula|inscrição|inscricao|nota|boletim|histórico|historico)\b[\s\S]{0,50}\b(de|do|da|d[oa]s)\b[\s\S]{0,40}\b(outr[oa]|terceir[oa]|alun[oa]|candidat[oa]|pessoa|fulano|cliente|lead|colega|amig[oa]|namorad[oa]|espos[oa]|marido|esposa|filh[oa]|mãe|mae|pai)\b/i
const RA_ALLOWED_CONTEXT_RX = /\b(ra|registro acad[eê]mico|n[úu]mero do aluno|n[úu]mero de matr[ií]cula acad[eê]mica)\b/i

const INSTITUTIONAL_LOCATION_RX =
  /\b(polos?\s+(ead|de\s+atendimento|abaixo|listados|cadastrados)|por este (n[uú]mero|canal|whatsapp|contato)|faculdade\s+sumar[eé]|central\s+(em\s+)?pinheiros|rua\s+alegrete)\b/i

/** Endereços dos polos EAD e da Central são informação institucional — não bloquear no guard. */
export function replyContainsInstitutionalLocationInfo(text) {
  const raw = String(text || '')
  if (!raw || raw.length < 8) return false
  if (INSTITUTIONAL_LOCATION_RX.test(raw)) return true
  const low = raw.toLowerCase()
  for (const polo of SUMARE_POLOS_EAD) {
    if (low.includes(polo.nome.toLowerCase())) return true
    const end = String(polo.endereco || '').trim()
    if (end.length >= 8 && low.includes(end.toLowerCase())) return true
  }
  return false
}

/**
 * Lead pede dados sensíveis de terceiros (não do próprio atendimento comercial).
 */
export function messageRequestsThirdPartySensitiveData(userMessage) {
  const t = String(userMessage || '').trim()
  if (!t || t.length < 6) return false
  if (THIRD_PARTY_DATA_REQUEST_RX.test(t)) return true
  return /\bme (passa|d[áa]|informa|fala)\b[\s\S]{0,40}\b(cpf|email|e-?mail|telefone|dados)\b[\s\S]{0,40}\b(de|do|da)\b/i.test(t)
}

/**
 * Lead pede explicitamente o RA (único dado sensível permitido).
 */
export function messageRequestsOwnRa(userMessage) {
  const t = String(userMessage || '').trim()
  if (!t) return false
  return RA_ALLOWED_CONTEXT_RX.test(t) && !THIRD_PARTY_DATA_REQUEST_RX.test(t)
}

/**
 * Detecta vazamento de dados sensíveis de candidatos na resposta ao lead.
 * RA pode aparecer quando o lead pediu o próprio RA.
 */
export function replyLeaksSensitiveCandidateData(reply, { userMessage = '' } = {}) {
  const text = String(reply || '')
  if (!text || text.length < 4) return { leak: false }

  const raAllowed = messageRequestsOwnRa(userMessage)

  if (CPF_FORMATTED_RX.test(text) || CPF_CONTEXT_RX.test(text)) {
    return { leak: true, code: 'lgpd_cpf_leak' }
  }
  if (RG_RX.test(text)) {
    return { leak: true, code: 'lgpd_rg_leak' }
  }
  if (PERSONAL_EMAIL_RX.test(text) || GENERIC_EMAIL_WITH_LABEL_RX.test(text)) {
    return { leak: true, code: 'lgpd_email_leak' }
  }
  if (PHONE_WITH_LABEL_RX.test(text)) {
    return { leak: true, code: 'lgpd_phone_leak' }
  }
  if (ADDRESS_LEAK_RX.test(text) && !replyContainsInstitutionalLocationInfo(text)) {
    return { leak: true, code: 'lgpd_address_leak' }
  }
  const textForBankCheck = text.replace(CURSO_BANCO_DE_DADOS_RX, 'curso tecnologo dados')
  if (BANK_LEAK_RX.test(textForBankCheck) || BANK_INSTITUTION_LEAK_RX.test(textForBankCheck)) {
    return { leak: true, code: 'lgpd_financial_leak' }
  }

  // RA só é permitido se o lead pediu o próprio RA; bloqueia RA espontâneo ou de terceiros.
  if (!raAllowed && /\b(registro acad[eê]mico|RA)\b[\s\S]{0,40}\d{4,}/i.test(text)) {
    return { leak: true, code: 'lgpd_ra_unrequested' }
  }

  return { leak: false }
}

export function lgpdGuardEnabled(env) {
  return String(env?.LGPD_REPLY_GUARD_ENABLED ?? 'true').trim().toLowerCase() !== 'false'
}

export function buildLgpdSystemHint(userMessage) {
  if (messageRequestsThirdPartySensitiveData(userMessage)) {
    return (
      'LGPD — PEDIDO DE DADOS DE TERCEIROS: o lead pediu informação cadastral/pessoal de outra pessoa. ' +
      'É PROIBIDO fornecer CPF, e-mail, telefone, endereço, status de matrícula ou qualquer dado de candidato/aluno que não seja o próprio titular identificado no atendimento. ' +
      'Responda com recusa educada citando LGPD e ofereça ajuda com informações institucionais ou consultor (distribuir_humano) se necessário. ' +
      'ÚNICA exceção de dado sensível permitido: RA (Registro Acadêmico) do próprio aluno, quando ele pedir explicitamente o RA dele e você tiver essa informação confirmada.'
    )
  }
  if (messageRequestsOwnRa(userMessage)) {
    return (
      'LGPD — RA: o lead pediu Registro Acadêmico (RA). Este é o único dado sensível de aluno que você pode informar, ' +
      'desde que seja do próprio titular e esteja confirmado no sistema. ' +
      'Se não tiver o RA, não invente — oriente a falar com consultor (distribuir_humano). ' +
      'Nunca informe RA de outra pessoa.'
    )
  }
  return (
    'LGPD — PROTEÇÃO DE DADOS: você só divulga informações institucionais da Faculdade Sumaré (cursos, valores, duração, taxa de matrícula, polos EAD com endereços, Central Pinheiros). ' +
    'PERMITIDO informar endereços dos polos de atendimento e da Central — são dados institucionais públicos. ' +
    'PROIBIDO informar dados pessoais/cadastrais de candidatos ou alunos (CPF, RG, e-mail, telefone, endereço residencial, pagamento, notas, situação de outro titular). ' +
    'Exceção: RA do próprio aluno quando ele pedir explicitamente e o dado estiver confirmado.'
  )
}
