/** Heurísticas do fluxo Form Sumar (template WhatsApp → salesbot pós-formulário). */

import { normalizeMessageForScope, messageLooksLikeOperationalChat } from './scopeHeuristics.js'
import {
  inboundLooksLikeAgentEchoOnly,
  messageAsksCoursePrice,
  sanitizeLeadInboundMessage,
} from './inboundMessageSanitize.js'
import { conversationHasActiveTopic } from './conversationContextHeuristics.js'
import { extractCursoAreaFromText, messageIsBareCourseSelection } from './cursoConfirmation.js'

export const INSCRICAO_FORM_STATUS_AGUARDANDO = 'aguardando_form_sumar'
/** Formulário recebido — salesbot de distribuição em andamento. */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO = 'aguardando_distribuicao_form'
export const INSCRICAO_FORM_STATUS_CONCLUIDO = 'form_sumar_concluido'
/** Antes do Form Sumar: aguardando o lead escolher o polo de inscrição. */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM = 'aguardando_escolha_polo_pre_form'
/** Formulário recebido — aguardando o lead escolher o polo (legado pós-form). */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_POLO = 'aguardando_escolha_polo'
/** Inscrição na API Sumaré feita; aguardando aceite do contrato no portal. */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE = 'aguardando_aceite_contrato'
/** Resumo enviado (curso/valor/taxa) — aguardando o lead AUTORIZAR a matrícula antes do formulário. */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_AUTORIZACAO = 'aguardando_autorizacao_matricula'

/** Marcador interno quando o WhatsApp Flow / Kommo sinaliza formulário preenchido. */
export const FORM_SUMAR_FLOW_COMPLETED_MARKER = '[FORMULARIO_SUMAR_PREENCHIDO]'
/** Lead já tem outra candidatura — aguardando confirmar nova inscrição em outro curso. */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO = 'aguardando_confirm_nova_inscricao'
/** Comprovante de pagamento recebido — consultor segue o atendimento. */
export const INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO = 'comprovante_pagamento_recebido'
/** Captação falhou (curso indisponível, dados inválidos) — consultor humano segue. Terminal para parar loops. */
export const INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR = 'distribuir_consultor'
/** Card Kommo completo, agente perguntou ao lead se mantém o polo do card antes de seguir express. */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO = 'aguardando_confirm_polo_kommo'
/** Lead declarou que não quer inscrição — aguardando confirmação explícita de desistência. */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA = 'aguardando_confirm_desistencia'
/** Desistência confirmada — lead movido para fila de perda e IA pausada. */
export const INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA = 'desistencia_concluida'

const MATRICULA_POS_FORM_TERMINAL_STATUSES = new Set([
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
  INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
  INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
])

/** Em andamento — não reprocessar pós-form nem salesbot 49813. */
const MATRICULA_POS_FORM_IN_PROGRESS_STATUSES = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA,
  ...MATRICULA_POS_FORM_TERMINAL_STATUSES,
])

/**
 * Matrícula pós-formulário já foi tratada — não reenviar mensagem ao reentrar no funil.
 * Usa status Supabase e timestamps/captação (evita reprocessar com status stale em aguardando).
 */
export function matriculaPosFormAlreadyProcessed(row) {
  if (!row || typeof row !== 'object') return false
  const status = String(row.inscricao_form_status || '').trim()
  if (MATRICULA_POS_FORM_IN_PROGRESS_STATUSES.has(status)) return true
  if (row.inscricao_form_recebido_at) {
    const waiting = [INSCRICAO_FORM_STATUS_AGUARDANDO, INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO]
    if (waiting.includes(status)) return false
    return true
  }
  if (row.captacao_contrato_link_at) return true
  if (row.captacao_candidato_id != null && String(row.captacao_candidato_id).trim() !== '') return true
  if (row.captacao_contrato_link != null && String(row.captacao_contrato_link).trim() !== '') return true
  return false
}

/**
 * Status que indicam que o Form Sumar JÁ FOI PREENCHIDO e a inscrição avançou
 * além do envio do formulário. Nesses estados o salesbot Formulario_Sum NUNCA
 * deve ser reativado (o lead já preencheu — reenviar gera o loop "preencha o
 * formulário"). Estados PRÉ-formulário (null, aguardando_form_sumar,
 * aguardando_escolha_polo_pre_form, aguardando_autorizacao_matricula,
 * aguardando_confirm_*) ficam DE FORA de propósito.
 */
const INSCRICAO_FORM_FILLED_STATUSES = new Set([
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
  INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
  INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
])

/**
 * Formulário de inscrição já foi preenchido (não reenviar o Formulario_Sum).
 * Usa apenas colunas seguras (inscricao_form_status + inscricao_form_recebido_at)
 * presentes em DADOS_CLIENTE_INSCRICAO_SELECT.
 */
export function inscricaoFormAlreadyFilled(row) {
  if (!row || typeof row !== 'object') return false
  const status = String(row.inscricao_form_status || '').trim()
  if (INSCRICAO_FORM_FILLED_STATUSES.has(status)) return true
  if (row.inscricao_form_recebido_at) return true
  return false
}

/** Lead cobra o formulário que ainda não chegou. */
export function messageAsksForFormResend(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 5) return false
  return (
    /\b(cad[eê]|cadê|onde|sumiu|manda|envia|reenvi)\b[\s\S]{0,45}\bformul[aá]rio\b/i.test(t) ||
    /\bformul[aá]rio\b[\s\S]{0,30}\b(cad[eê]|cadê|onde|n[aã]o\s+chegou)\b/i.test(t) ||
    /\bn[aã]o\s+(recebi|chegou|veio)\b[\s\S]{0,30}\bformul[aá]rio\b/i.test(t)
  )
}

export function lastAssistantText(historyMessages) {
  const assistants = (historyMessages || []).filter((m) => m.role === 'assistant')
  if (!assistants.length) return ''
  return String(assistants[assistants.length - 1].content || '')
}

/** Lead pede catálogo / informação sobre cursos — não é pedido de inscrição. */
export function messageIsCourseCatalogRequest(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 6) return false
  const aboutCourses =
    /\b(curso|curso[s]?|gradua[cç][aã]o|p[oó]s|forma[cç][õo]es|mba|especializa)\b/i.test(t)
  if (!aboutCourses) return false
  if (/\b(fazer|matricul|inscri|me\s+inscrever|realizar\s+a\s+inscri)\b/i.test(t)) return false
  const asksInfo =
    /\b(saber|conhecer|informa|listar|mostrar|ver|quais|op[cç][oõ]es|cat[aá]logo|dispon[ií]veis|oferecem|tenha|voc[eê]\s+tem)\b/i.test(t)
  const popular = /\b(pedidos?|procurad|mais\s+vendidos?|destaques?)\b/i.test(t)
  if (asksInfo || popular) return true
  if (/\bquais\s+(s[aã]o\s+)?(os\s+)?curso/i.test(t)) return true
  return false
}

/** Assistente perguntou ao lead se autoriza a CONCLUSÃO da matrícula (resumo pré-formulário). */
export function assistantAskedMatriculaAuthorization(lastAssist) {
  const a = String(lastAssist || '').toLowerCase()
  if (!a) return false
  return (
    /\bautoriz\w*\b[\s\S]{0,40}\b(conclus|matr[ií]cula|inscri)\b/i.test(a) ||
    /\bvoc[eê]\s+autoriza\b/i.test(a) ||
    /\b(taxa\s+de\s+matr[ií]cula)\b[\s\S]{0,120}\bautoriz/i.test(a)
  )
}

/** Assistente já apresentou curso e perguntou se o lead quer seguir com inscrição/matrícula. */
export function assistantInEnrollmentStep(lastAssist) {
  const a = String(lastAssist || '').toLowerCase()
  if (!a) return false
  return (
    /\b(deseja|quer|gostaria|posso)\b[\s\S]{0,70}\b(seguir|inscri|matricul|prosseguir|enviar|mandar|ativar)\b/i.test(a) ||
    /\b(seguir|prosseguir)\b[\s\S]{0,45}\b(com\s+a\s+)?(inscri|matricul)\b/i.test(a) ||
    /\b(enviar|mandar|ativar)\b[\s\S]{0,40}\bformul[aá]rio\b/i.test(a) ||
    /\bformul[aá]rio\b[\s\S]{0,50}\b(inscri|matricul|enviar)\b/i.test(a) ||
    /\b(ajud(e|ar)|te\s+ajud)\b[\s\S]{0,45}\b(com\s+a\s+)?(inscri|matricul)/i.test(a) ||
    /\binscri[cç][aã]o\s+nesse\s+curso\b/i.test(a) ||
    /\bquer\s+que\s+eu\b[\s\S]{0,55}\b(inscri|matricul)/i.test(a) ||
    /\b(posso|pode)\b[\s\S]{0,40}\b(seguir|continuar)\b[\s\S]{0,30}\b(inscri|matricul)/i.test(a) ||
    // Resumo de confirmação pré-formulário ("...Você autoriza a conclusão da matrícula?")
    assistantAskedMatriculaAuthorization(a)
  )
}

/** Confirmação curta típica após pergunta de inscrição ("sim", "ok", "pode"). */
export function isShortEnrollmentConfirmation(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim().replace(/[.!?]+$/, '')
  if (!t || t.length > 24) return false
  return /^\s*(sim|s|ok|okay|pode|bora|vamos|quero|isso|claro|beleza|pode\s+ser|t[aá]|ta)\s*$/i.test(t)
}

/** Confirmação curta quando o assistente já está no passo de inscrição / ingresso. */
function userConfirmsEnrollmentAfterAssistant(text, historyMessages) {
  const lastAssist = lastAssistantText(historyMessages)
  if (!assistantInEnrollmentStep(lastAssist)) return false

  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length > 80) return false
  if (messageIsCourseCatalogRequest(text)) return false
  if (/\b(saber|conhecer|informa|listar|quais|valores|pre[cç]o|dura[cç]|pedidos|mais\s+procurad)\b/i.test(t)) {
    return false
  }

  if (/\bquero\s+esse\s+curso\b/i.test(t)) return true
  if (/\b(quero|gostei)\b/i.test(t) && /\b(esse|essa)\s+curso\b/i.test(t)) return true

  return /^\s*(sim|s|quero|pode|bora|vamos|ok|gostei|esse\s+curso|fazer|isso)\b/i.test(t)
}

/**
 * Lead citou interesse em um curso, mas ainda não confirmou matrícula/inscrição.
 * Ex.: "quero fazer curso de ads", "quero o curso de enfermagem".
 */
export function messageExpressesCourseInterestOnly(text, historyMessages = []) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  if (messageIsBareCourseSelection(text, historyMessages)) return true
  if (extractCursoAreaFromText(text) && t.length <= 80 && !/\b(inscri|matricul|formul)/i.test(t)) {
    return true
  }
  if (messageConfirmsProceedToInscricaoForm(text, historyMessages)) return false
  if (messageAsksForFormResend(text)) return false
  if (messageLooksLikeOperationalChat(text)) return false

  if (messageIsCourseCatalogRequest(text)) return true

  if (/\bquero\b/i.test(t) && /\b(curso|fazer)\b/i.test(t)) return true
  if (/\bquero\s+(o\s+)?curso\s+de\b/i.test(t)) return true
  if (/\b(interesse|gostaria)\b/i.test(t) && /\b(curso|fazer|estudar)\b/i.test(t)) return true
  if (/\bquero\s+fazer\b/i.test(t) && !/\b(inscri|matricul|me\s+inscrever)\b/i.test(t)) return true

  return false
}

/**
 * Lead confirmou que quer seguir com matrícula/inscrição — momento de enviar o formulário.
 * Não dispara em "quero fazer curso de X" sem confirmação após informações do curso.
 */
export function messageConfirmsProceedToInscricaoForm(text, historyMessages = []) {
  const cleaned = sanitizeLeadInboundMessage(text)
  const t = normalizeMessageForScope(cleaned).toLowerCase()
  if (!t) return false

  if (inboundLooksLikeAgentEchoOnly(text)) return false
  if (messageAsksCoursePrice(cleaned)) return false

  if (messageLooksLikeOperationalChat(text)) return false
  if (messageLooksLikeFormSumarResponse(text)) return false
  if (messageAsksForFormResend(text)) return true
  if (messageIsCourseCatalogRequest(text)) return false

  if (
    /^\s*(inscri[cç][aã]o|matr[ií]cula|me\s+inscrever|quero\s+me\s+inscrever)\s*[.!?]*\s*$/i.test(t) &&
    (assistantInEnrollmentStep(lastAssistantText(historyMessages)) ||
      conversationHasActiveTopic(historyMessages))
  ) {
    return true
  }

  if (
    /\b(valor|valores|pre[cç]o|mensalidade|dura[cç][aã]o|quanto\s+custa|grade)\b/i.test(t) &&
    !/\b(fazer|matricul|inscri|me\s+inscrever)\b/i.test(t)
  ) {
    return false
  }

  if (userConfirmsEnrollmentAfterAssistant(text, historyMessages)) return true

  if (
    conversationHasActiveTopic(historyMessages) &&
    /^\s*(inscri[cç][aã]o|matr[ií]cula|quero\s+me\s+inscrever|quero\s+matricular)\s*[.!?]*\s*$/i.test(t)
  ) {
    return true
  }

  if (
    /\b(realizar|efetuar|concluir|continuar|prosseguir|seguir|avan[cç]ar|iniciar|come[cç]ar)\b[\s\S]{0,45}\b(inscri[cç][aã]o|cadastro|matr[ií]cula)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (
    /\b(quero|gostaria|preciso|posso|vou)\b[\s\S]{0,40}\b(me\s+inscrever|inscrever|matricular|realizar\s+a\s+inscri)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\b(quero|preciso|vou)\b[\s\S]{0,25}\b(matr[ií]cula|inscri[cç][aã]o)\b/i.test(t)) return true
  if (/\b(matr[ií]cula|inscri[cç][aã]o)\b[\s\S]{0,30}\b(agora|j[aá]|por\s+favor)\b/i.test(t)) return true

  if (/\bgostei\b/i.test(t) && /\bquero\b/i.test(t) && /\b(fazer|inscri|matricul)\b/i.test(t)) {
    return userConfirmsEnrollmentAfterAssistant(text, historyMessages)
  }

  return false
}

/** @deprecated Use messageConfirmsProceedToInscricaoForm — mantido para imports existentes. */
export function messageRequestsInscricaoForm(text, historyMessages = []) {
  return messageConfirmsProceedToInscricaoForm(text, historyMessages)
}

/**
 * Confirmação após o formulário ter sido enviado (status aguardando).
 * Em `strictAwaitingForm`, ok/pronto/feito NÃO disparam pós-form (evita matrícula sem Flow).
 */
export function messageLooksLikeFormFollowUp(text, options = {}) {
  const strict = Boolean(options.strictAwaitingForm)
  const t = normalizeMessageForScope(text).toLowerCase().trim()
  if (!t || t.length > 60) return false
  if (messageLooksLikeOperationalChat(text)) return false
  if (
    /\b(preenchid[oa]?|respondid[oa]?|enviei|mandei|terminei|finalizei|j[aá]\s+preenchi)\b/i.test(t) ||
    /^\s*preenchid[oa]?\s*[.!?]*\s*$/i.test(t)
  ) {
    return true
  }
  if (/^\s*(e\s+agora|e\s+ai|e\s+aí)\s*[.!?]*\s*$/i.test(t)) return true
  if (!strict && /^\s*(ok|pronto|feito|done|enviei|mandei)\s*[.!?]*\s*$/i.test(t)) return true
  return false
}

/** Lead sinaliza que acabou de enviar / concluir o Form Sumar (inclui "pronto", Flow, etc.). */
export function messageSignalsFormSubmissionAck(text) {
  return (
    messageLooksLikeFormSumarResponse(text) ||
    messageIsFlowResponsesReceived(text) ||
    messageLooksLikeFormFollowUp(text, { strictAwaitingForm: false })
  )
}

/** Eco de mensagem enviada pelo agente (sufixo EX-… nas notas Kommo). */
export function messageLooksLikeAgentOutboundEcho(text) {
  return /\s-\s+EX-\d{6}-\d{4}-\d{3}/i.test(String(text || ''))
}

/**
 * Texto padrão do WhatsApp/Meta/Kommo quando o lead conclui o Flow do formulário.
 * Ex.: "Flow responses received" (inglês) — não confundir com fala do lead.
 */
export function messageIsFlowResponsesReceived(text) {
  const raw = String(text || '').trim()
  if (!raw || raw.length < 8) return false
  if (raw === FORM_SUMAR_FLOW_COMPLETED_MARKER) return true
  if (messageLooksLikeAgentOutboundEcho(raw)) return false
  const t = raw.toLowerCase()
  if (/^flow\s+responses\s+received\.?$/i.test(t)) return true
  if (/\bflow\s+responses\s+received\b/i.test(t)) return true
  if (/\brespostas\s+recebidas\s+(no\s+)?flow\b/i.test(t)) return true
  if (/\brespostas?\s+do\s+flow\s+recebidas?\b/i.test(t)) return true
  return false
}

export function messageIsFormularioSumarPreenchidoMarker(text) {
  return String(text || '').trim() === FORM_SUMAR_FLOW_COMPLETED_MARKER
}

/**
 * Extrai campos rotulados de uma NOTA de dados do formulário (escrita pelo n8n
 * no Kommo após o Flow), ex.:
 *   "CPF: 48281105852\nDATA DE NASCIMENTO: 02/04/1999\nNOME: ...\nEMAIL: ...\n
 *    TELEFONE INSCRICAO: ...\nSEXO: Masculino"
 * Devolve só os campos com valor real (ignora vazio / n/a / "não informado").
 * Usado como FALLBACK quando o campo personalizado do Kommo veio vazio
 * (ex.: o n8n grava o e-mail só na nota e não no campo `sum_Email`).
 */
export function parseFormDataNoteFields(text) {
  const raw = String(text || '')
  if (!raw) return {}
  const pick = (labelPattern) => {
    const re = new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*[:=]\\s*([^\\n]+)`, 'i')
    const m = raw.match(re)
    if (!m) return ''
    const v = String(m[1] || '').trim()
    if (!v) return ''
    if (/^n\/a$/i.test(v)) return ''
    if (/^n[ãa]o informad[oa]\.?$/i.test(v)) return ''
    if (v === '-' || v === '—') return ''
    return v
  }
  const out = {}
  const nome = pick('nome completo|nome')
  const cpf = pick('cpf|documento')
  const emailRaw = pick('e-?mail')
  // Só aceita e-mail com formato válido — a nota do n8n às vezes corrompe o "@"
  // (ex.: "...0204@gmail.com" vira "...02042gmail.com"). E-mail inválido =
  // ausente, para não matricular com lixo nem pausar o lead indevidamente.
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : ''
  const dataNasc = pick('data de nascimento|data nascimento|data_nasc|nascimento')
  const telefone = pick('telefone inscri[cç][aã]o|telefone|celular')
  const sexo = pick('sexo|g[eê]nero')
  if (nome) out.nome = nome
  if (cpf) out.cpf = cpf
  if (email) out.email = email
  if (dataNasc) out.data_nasc = dataNasc
  if (telefone) out.telefone = telefone
  if (sexo) out.sexo = sexo
  return out
}

/** Texto normalizado para o buffer quando o Kommo/WhatsApp sinaliza Flow concluído. */
export function inboundTextForFormFlowCompletion(text) {
  if (messageIsFlowResponsesReceived(text)) return FORM_SUMAR_FLOW_COMPLETED_MARKER
  return String(text || '').trim()
}

/** Histórico recente indica que o Form Sumar já foi preenchido (Flow ou confirmação do lead). */
export function historyIndicatesFormSumarCompleted(historyMessages, windowSize = 12) {
  const recent = (historyMessages || []).slice(-windowSize)
  for (const m of recent) {
    const content = String(m?.content || '').trim()
    if (!content) continue
    if (messageSignalsFormSubmissionAck(content)) return true
  }
  return false
}

/** Resposta do WhatsApp Flow / formulário "Form Sumar" após preenchimento. */
export function messageLooksLikeFormSumarResponse(text) {
  const raw = String(text || '').trim()
  if (!raw || raw.length < 4) return false
  if (messageLooksLikeAgentOutboundEcho(raw)) return false
  if (messageIsFlowResponsesReceived(raw)) return true
  const t = raw.toLowerCase()

  if (/\[formulario\s+sumar\]/i.test(raw)) return true
  if (/\brespostas\s+recebidas\s+no\s+flow\b/i.test(t)) return true
  if (/\bflow\b/i.test(t) && /\b(respondid|recebid|preenchid|enviad)\b/i.test(t)) return true
  if (/\bnfm_reply\b/i.test(t) || /\bresponse_json\b/i.test(t)) return true
  if (/^\s*[\{\[]/.test(raw) && /"(nome|name|email|e-mail|telefone|phone|cpf|curso)"/i.test(raw)) {
    return true
  }
  if (
    /\b(nome|e-?mail|telefone|cpf|curso|ingresso)\s*[:=]/i.test(raw) &&
    /\b(nome|e-?mail|telefone|cpf)\s*[:=]/i.test(raw)
  ) {
    return true
  }
  if (/\bformul[aá]rio\b/i.test(t) && /\b(preenchido|enviado|respondido|conclu[ií]do)\b/i.test(t)) {
    if (/\b(recebi|obrigad[oa]|registramos|validamos|cadastro)\b/i.test(t) && !/\b(flow|nfm_reply)\b/i.test(t)) {
      return false
    }
    return true
  }
  if (/^\s*preenchid[oa]?\s*[.!?]*\s*$/i.test(t)) return true
  return false
}

export function buildInscricaoFormSentReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  if (opts.resend) {
    return (
      `Claro${nameBit}! Acabei de reativar o envio do formulário de inscrição aqui no WhatsApp. ` +
      `Confira a mensagem com o botão "Formulário" e preencha quando puder, tudo bem?`
    )
  }
  return (
    `Perfeito${nameBit}! Para dar continuidade à sua inscrição na Faculdade Sumaré, acabei de enviar ` +
    `o formulário de dados básicos aqui no WhatsApp. É rapidinho — preencha e envie; em seguida ` +
    `nossa equipe segue com o próximo passo com você por aqui.`
  )
}

export function buildInscricaoFormFieldsIncompleteReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const missing = Array.isArray(opts.missingFields) ? opts.missingFields : []
  const list = missing.length ? missing.join(', ') : 'alguns dados do cadastro'
  return (
    `Obrigado${nameBit}! Recebemos o formulário, mas ainda faltam informações no cadastro: **${list}**. ` +
    `Um consultor pode te ajudar a completar — ou, se preferir, preencha novamente o formulário quando reenviarmos. ` +
    `Posso esclarecer qualquer dúvida sobre o curso enquanto isso.`
  )
}

export function buildInscricaoFormCompleteReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  if (opts.ok) {
    return (
      `Perfeito${nameBit}! Seu cadastro foi validado e já iniciamos o próximo passo da matrícula na Faculdade Sumaré. ` +
      `Em breve nossa equipe segue com você por aqui para finalizar tudo, tudo bem?`
    )
  }
  return (
    `Obrigado${nameBit}! Registramos o formulário. Um consultor da Faculdade Sumaré entrará em contato em breve para concluir sua inscrição.`
  )
}

/** Lead pede reenvio do link do contrato / pagamento. */
export function messageAsksContratoLinkResend(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  return (
    /\b(reenvi\w*|manda|envia|cad[eê]|cadê|perdi|sumiu|n[aã]o\s+(abre|abriu|consigo|achei))\b[\s\S]{0,50}\b(link|contrato|pagamento|boleto|pix)\b/i.test(
      t,
    ) ||
    /\b(link|contrato)\b[\s\S]{0,35}\b(reenvi\w*|manda|envia|de\s+novo)\b/i.test(t) ||
    /\bqual\s+(é|e)\s+o\s+link\b/i.test(t)
  )
}

/** Imagem ou texto indicando comprovante / pagamento realizado. */
export function messageLooksLikePaymentProof(text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  if (/^\[(IMAGEM RECEBIDA|ÁUDIO RECEBIDO)/i.test(raw)) return true
  const t = normalizeMessageForScope(text).toLowerCase()
  if (
    /\b(comprovante|comprovativo|print\s+do\s+pagamento|print\s+de\s+pagamento|captura\s+de\s+tela)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\b(segue|envio|mandei|anexo)\b[\s\S]{0,40}\b(comprovante|pagamento|pix|boleto)\b/i.test(t)) return true
  if (/\b(paguei|pagamento\s+feito|j[aá]\s+paguei|efetuei\s+o\s+pagamento|transferi)\b/i.test(t)) return true
  if (/\b(pix|boleto|transfer[eê]ncia)\b/i.test(t) && /\b(pag|feito|confirmad|realizad)\b/i.test(t)) return true
  return false
}

/** Mesmo curso já em andamento na Sumaré (pagamento / matrícula pendente). */
export function buildSameCourseInProgressReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const curso = String(opts.cursoNome || 'seu curso').trim()
  const link = String(opts.contractUrl || '').trim()
  let body =
    `Perfeito${nameBit}! Identificamos que você já possui uma *candidatura em andamento* para *${curso}* na Faculdade Sumaré.\n\n` +
    `Não é necessário fazer uma nova inscrição para o mesmo curso. Para concluir a matrícula e iniciar as aulas, ` +
    `acesse o link abaixo e finalize o *pagamento da matrícula* (PIX, boleto ou cartão):\n\n`
  if (link) body += `${link}\n\n`
  body +=
    `Depois do pagamento, envie aqui no WhatsApp o *print do comprovante* para seguirmos com os próximos passos.\n\n` +
    `Qualquer dúvida, é só responder por aqui.`
  return body
}

/** Pergunta se deseja nova inscrição quando já existe candidatura em outro curso. */
export function buildConfirmNovaInscricaoReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const cursoNovo = String(opts.cursoNovo || 'o novo curso').trim()
  const cursoExistente = String(opts.cursoExistente || 'outro curso').trim()
  return (
    `Olá${nameBit}! Identificamos que você já possui *inscrição em andamento* na Faculdade Sumaré ` +
    `(curso: *${cursoExistente}*).\n\n` +
    `Você solicitou matrícula em *${cursoNovo}*, que é um *curso diferente*.\n\n` +
    `Deseja realizar uma *nova inscrição* para *${cursoNovo}*? Responda *sim* para continuar com a nova inscrição ` +
    `ou *não* para seguir com a candidatura que já está em andamento.`
  )
}

/** Lead escolheu não abrir nova inscrição — reenvia link da candidatura atual. */
export function buildMantemInscricaoExistenteReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const curso = String(opts.cursoNome || 'sua candidatura atual').trim()
  const link = String(opts.contractUrl || '').trim()
  let body =
    `Sem problema${nameBit}! Vamos seguir com a candidatura que você já tem em andamento para *${curso}*.\n\n`
  if (link) {
    body += `Acesse o link para concluir a matrícula (pagamento ou contrato, conforme sua etapa):\n\n${link}\n\n`
  }
  body += `Se precisar de ajuda, é só responder por aqui.`
  return body
}

/** Mensagem após inscrição na API Sumaré — link do portal (contrato ou pagamento). */
export function buildContratoAceiteLinkReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const link = String(opts.contractUrl || '').trim()
  if (!link) return buildInscricaoFormCompleteReply({ pushName: opts.pushName, ok: false })

  const phase =
    opts.portalPhase === 'pagamento' || /meiopagamento/i.test(link) ? 'pagamento' : 'contrato'

  if (phase === 'pagamento') {
    return (
      `Ótimo${nameBit}! Sua inscrição foi registrada na Faculdade Sumaré.\n\n` +
      `Seu cadastro já está na etapa de *pagamento da matrícula*. Acesse o link abaixo para escolher ` +
      `PIX, boleto ou cartão:\n\n` +
      `${link}\n\n` +
      `Depois que concluir o pagamento, envie aqui no WhatsApp um *print ou foto do comprovante* ` +
      `para darmos continuidade aos próximos passos da sua matrícula.\n\n` +
      `Qualquer dúvida, é só responder por aqui.`
    )
  }

  return (
    `Ótimo${nameBit}! Sua inscrição foi registrada na Faculdade Sumaré.\n\n` +
    `Para concluir a matrícula, acesse o link abaixo:\n\n` +
    `${link}\n\n` +
    `*Você* deve abrir o link, ler os termos, marcar a concordância e clicar em *ASSINAR CONTRATO* — ` +
    `a inscrição só é concluída quando *você* aceita o contrato no portal (não fazemos isso por você). ` +
    `Em seguida, realize o *pagamento da matrícula* na mesma página.\n\n` +
    `Depois que o pagamento for confirmado, envie aqui no WhatsApp um *print ou foto do comprovante* ` +
    `para darmos continuidade aos próximos passos da sua matrícula.\n\n` +
    `Qualquer dúvida sobre o contrato ou o pagamento, é só responder por aqui.`
  )
}

export function buildContratoLinkResendReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const link = String(opts.contractUrl || '').trim()
  if (!link) {
    return (
      `Claro${nameBit}! Um consultor da Faculdade Sumaré vai te enviar o link do contrato em instantes por aqui, tudo bem?`
    )
  }
  const phase =
    opts.portalPhase === 'pagamento' || /meiopagamento/i.test(link) ? 'pagamento' : 'contrato'
  if (phase === 'pagamento') {
    return (
      `Sem problema${nameBit}! Segue novamente o link para *pagamento da matrícula* (PIX, boleto ou cartão):\n\n` +
      `${link}\n\n` +
      `Após pagar, envie o *print do comprovante* aqui no WhatsApp para seguirmos com sua matrícula.`
    )
  }
  return (
    `Sem problema${nameBit}! Segue novamente o link para *aceitar o contrato* e fazer o *pagamento*:\n\n` +
    `${link}\n\n` +
    `Após pagar, envie o *print do comprovante* aqui no WhatsApp para seguirmos com sua matrícula.`
  )
}

export function buildPagamentoSemComprovanteReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const link = String(opts.contractUrl || '').trim()
  const linkBit = link
    ? `\n\nSe ainda não concluiu, use o link: ${link}`
    : ''
  return (
    `Obrigado${nameBit}! Para seguirmos, preciso que você envie aqui uma *foto ou print do comprovante de pagamento* ` +
    `(PIX, boleto ou cartão — o que utilizou).${linkBit}`
  )
}

export function buildComprovantePagamentoRecebidoReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Agradecemos sua matrícula${nameBit}! ` +
    `Em breve, assim que seu pagamento for reconhecido, vamos encaminhar aqui as informações ` +
    `de como prosseguir para iniciar o curso. Qualquer dúvida, é só responder por aqui.`
  )
}
