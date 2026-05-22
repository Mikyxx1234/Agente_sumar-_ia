/** Heurísticas do fluxo Form Sumar (template WhatsApp → salesbot pós-formulário). */

import { normalizeMessageForScope, messageLooksLikeOperationalChat } from './scopeHeuristics.js'
import { conversationHasActiveTopic } from './conversationContextHeuristics.js'
import { extractCursoAreaFromText, messageIsBareCourseSelection } from './cursoConfirmation.js'

export const INSCRICAO_FORM_STATUS_AGUARDANDO = 'aguardando_form_sumar'
/** Formulário recebido — salesbot de distribuição em andamento. */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO = 'aguardando_distribuicao_form'
export const INSCRICAO_FORM_STATUS_CONCLUIDO = 'form_sumar_concluido'
/** Formulário recebido — aguardando o lead escolher o polo (antes da API Captação). */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_POLO = 'aguardando_escolha_polo'
/** Inscrição na API Sumaré feita; aguardando aceite do contrato no portal. */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE = 'aguardando_aceite_contrato'
/** Comprovante de pagamento recebido — consultor segue o atendimento. */
export const INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO = 'comprovante_pagamento_recebido'

const MATRICULA_POS_FORM_TERMINAL_STATUSES = new Set([
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
])

/** Em andamento — não reprocessar pós-form nem salesbot 49813. */
const MATRICULA_POS_FORM_IN_PROGRESS_STATUSES = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
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
  if (row.inscricao_form_recebido_at) return true
  if (row.captacao_contrato_link_at) return true
  if (row.captacao_candidato_id != null && String(row.captacao_candidato_id).trim() !== '') return true
  if (row.captacao_contrato_link != null && String(row.captacao_contrato_link).trim() !== '') return true
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

/** Assistente já apresentou curso e perguntou se o lead quer seguir com inscrição/matrícula. */
export function assistantInEnrollmentStep(lastAssist) {
  const a = String(lastAssist || '').toLowerCase()
  if (!a) return false
  return (
    /\b(deseja|quer|gostaria|posso)\b[\s\S]{0,70}\b(seguir|inscri|matricul|prosseguir|enviar|mandar|ativar)\b/i.test(a) ||
    /\b(seguir|prosseguir)\b[\s\S]{0,45}\b(com\s+a\s+)?(inscri|matricul)\b/i.test(a) ||
    /\b(enviar|mandar|ativar)\b[\s\S]{0,40}\bformul[aá]rio\b/i.test(a) ||
    /\bformul[aá]rio\b[\s\S]{0,50}\b(inscri|matricul|enviar)\b/i.test(a)
  )
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
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t) return false

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
  if (!strict && /^\s*(ok|pronto|feito|done)\s*[.!?]*\s*$/i.test(t)) return true
  return false
}

/** Eco de mensagem enviada pelo agente (sufixo EX-… nas notas Kommo). */
export function messageLooksLikeAgentOutboundEcho(text) {
  return /\s-\s+EX-\d{6}-\d{4}-\d{3}/i.test(String(text || ''))
}

/** Resposta do WhatsApp Flow / formulário "Form Sumar" após preenchimento. */
export function messageLooksLikeFormSumarResponse(text) {
  const raw = String(text || '').trim()
  if (!raw || raw.length < 4) return false
  if (messageLooksLikeAgentOutboundEcho(raw)) return false
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

/** Mensagem após inscrição na API Sumaré — link do portal de aceite do contrato. */
export function buildContratoAceiteLinkReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const link = String(opts.contractUrl || '').trim()
  if (!link) return buildInscricaoFormCompleteReply({ pushName: opts.pushName, ok: false })
  return (
    `Ótimo${nameBit}! Sua inscrição foi registrada na Faculdade Sumaré.\n\n` +
    `Para concluir a matrícula, acesse o link abaixo:\n\n` +
    `${link}\n\n` +
    `Nesse link você deve *aceitar o contrato* (ler os termos, marcar a concordância e clicar em *ASSINAR CONTRATO*) ` +
    `e, em seguida, realizar o *pagamento da matrícula* na mesma página.\n\n` +
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
    `Perfeito${nameBit}! Recebemos seu comprovante de pagamento. ` +
    `Nossa equipe vai conferir e em breve um consultor da Faculdade Sumaré entra em contato por aqui para os próximos passos da sua matrícula, tudo bem?`
  )
}
