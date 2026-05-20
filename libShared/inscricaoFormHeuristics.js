/** Heurísticas do fluxo Form Sumar (template WhatsApp → salesbot pós-formulário). */

import { normalizeMessageForScope, messageLooksLikeOperationalChat } from './scopeHeuristics.js'

export const INSCRICAO_FORM_STATUS_AGUARDANDO = 'aguardando_form_sumar'
/** Formulário recebido — salesbot de distribuição em andamento. */
export const INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO = 'aguardando_distribuicao_form'
export const INSCRICAO_FORM_STATUS_CONCLUIDO = 'form_sumar_concluido'

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
    /\b(valor|valores|pre[cç]o|mensalidade|dura[cç][aã]o|quanto\s+custa|grade)\b/i.test(t) &&
    !/\b(fazer|matricul|inscri|me\s+inscrever)\b/i.test(t)
  ) {
    return false
  }

  if (userConfirmsEnrollmentAfterAssistant(text, historyMessages)) return true

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
 * Confirmação curta após o formulário ter sido enviado (status aguardando).
 * Ex.: "preenchido", "e agora", "pronto".
 */
export function messageLooksLikeFormFollowUp(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim()
  if (!t || t.length > 60) return false
  if (messageLooksLikeOperationalChat(text)) return false
  if (
    /\b(preenchid[oa]?|respondid[oa]?|enviei|mandei|terminei|finalizei|j[aá]\s+preenchi)\b/i.test(t) ||
    /^\s*preenchid[oa]?\s*[.!?]*\s*$/i.test(t)
  ) {
    return true
  }
  if (/^\s*(e\s+agora|e\s+ai|e\s+aí|ok|pronto|feito|done)\s*[.!?]*\s*$/i.test(t)) return true
  return false
}

/** Resposta do WhatsApp Flow / formulário "Form Sumar" após preenchimento. */
export function messageLooksLikeFormSumarResponse(text) {
  const raw = String(text || '').trim()
  if (!raw || raw.length < 4) return false
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
  if (/\bformul[aá]rio\b/i.test(t) && /\b(preenchido|enviado|respondido|conclu[ií]do)\b/i.test(t)) return true
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
