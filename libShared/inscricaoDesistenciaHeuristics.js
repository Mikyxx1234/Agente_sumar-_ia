/**
 * Heurísticas do fluxo de desistência de inscrição (lead não quer seguir
 * após o agente apresentar o curso e tirar dúvidas).
 */

import { normalizeMessageForScope } from './scopeHeuristics.js'
import {
  conversationHasActiveTopic,
  assistantAskedEnrollmentInLastReply,
  lastAssistantText,
} from './conversationContextHeuristics.js'
import { messageConfirmsProceedToInscricaoForm } from './inscricaoFormHeuristics.js'

/** Assistente pediu confirmação de desistência (texto canônico deste fluxo). */
export function assistantAskedDesistenciaConfirm(text) {
  const a = String(text || '')
    .replace(/\s-\s+EX-\d{6}-\d{4}-\d{3}(-[a-f0-9]+)?\s*$/i, '')
    .toLowerCase()
  if (!a) return false
  return (
    /\bn[aã]o\s+deseja\s+mesmo\s+seguir\b/i.test(a) &&
    /\b(desist[eê]ncia|desistir)\b/i.test(a) &&
    (/\bconfirme\b/i.test(a) || /\bconfirmo\b/i.test(a) || /responda\s+por\s+aqui/i.test(a))
  )
}

/**
 * Houve engajamento sobre curso: agente falou do curso e o lead participou
 * (perguntas, dúvidas) antes de declarar que não quer inscrição.
 */
export function conversationHadCourseEngagement(historyMessages = []) {
  if (!conversationHasActiveTopic(historyMessages)) return false

  let assistantCourseTurns = 0
  let userParticipated = false

  for (const m of historyMessages || []) {
    const content = String(m?.content || '')
    const role = String(m?.role || '').toLowerCase()
    if (role === 'assistant' || role === 'assistente') {
      if (
        /\b(curso|gradua[cç][aã]o|ead|mensalidade|matr[ií]cula|inscri[cç][aã]o|valor|pre[cç]o|dura[cç][aã]o|grade|vestibular|ingresso)\b/i.test(
          content,
        )
      ) {
        assistantCourseTurns += 1
      }
    }
    if (role === 'user' || role === 'lead') {
      const t = normalizeMessageForScope(content)
      if (t.length >= 6 && !/^(oi|ol[aá]|bom dia|boa tarde|boa noite)\s*$/i.test(t)) {
        userParticipated = true
      }
    }
  }

  return assistantCourseTurns >= 1 && userParticipated
}

/** Lead declarou que não quer seguir com a inscrição / matrícula. */
export function messageExpressesEnrollmentDecline(text, historyMessages = []) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false

  // Antes do guard de confirmação de inscrição — "não quero me inscrever"
  // contém "quero me inscrever" e geraria falso negativo.
  const inscricaoWord = /\b(inscrever|matricular|inscri[cç][aã]o|matr[ií]cula|curso)\b/i

  if (
    /\bn[aã]o\b/i.test(t) &&
    /\b(quero|vou|pretendo|tenho\s+interesse|desejo)\b/i.test(t) &&
    inscricaoWord.test(t)
  ) {
    return true
  }

  if (messageConfirmsProceedToInscricaoForm(text, historyMessages)) return false

  if (
    /\b(n[aã]o\s+quero|n[aã]o\s+tenho\s+interesse|sem\s+interesse)\b[\s\S]{0,40}/i.test(t) &&
    inscricaoWord.test(t)
  ) {
    return true
  }
  if (/\b(desistir|desist[eê]ncia|desisto)\b/i.test(t) && inscricaoWord.test(t)) {
    return true
  }
  if (/\bn[aã]o\s+(vou|pretendo|quero)\s+(me\s+)?(inscrever|matricular)\b/i.test(t)) return true
  if (/\bn[aã]o\s+quero\s+seguir\b/i.test(t)) return true
  if (/\bdeixa\s+(pra\s+l[aá]|quieto)\b/i.test(t) && /\b(inscri|matricul|curso)\b/i.test(t)) return true
  if (/^\s*n[aã]o\s*[.!?]*\s*$/i.test(t) && assistantAskedEnrollmentInLastReply(historyMessages)) {
    return true
  }
  if (
    /\bagora\s+n[aã]o\b/i.test(t) &&
    /\b(inscri|matricul|curso)\b/i.test(t)
  ) {
    return true
  }
  return false
}

/** Lead confirmou a desistência após a pergunta canônica do agente. */
export function messageConfirmsFinalDesistencia(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim().replace(/[.!?]+$/, '')
  if (!t || t.length > 80) return false
  if (/^\s*(n[aã]o|nao)\s*$/i.test(t)) return true
  if (/\b(sim|confirmo|pode\s+encerrar|quero\s+desistir|desisto|desistir)\b/i.test(t)) {
    if (/\b(n[aã]o\s+quero\s+mais|desistir|desist[eê]ncia|encerrar)\b/i.test(t)) return true
    if (/^\s*(sim|confirmo|desisto)\s*$/i.test(t)) return true
    if (/\bsim\b/i.test(t) && /\bdesist/i.test(t)) return true
  }
  if (/\bn[aã]o\s+quero\s+mesmo\s+seguir\b/i.test(t)) return true
  if (/\bconfirmo\s+a\s+desist/i.test(t)) return true
  return false
}

/** Lead voltou atrás — quer seguir com inscrição ou outro curso. */
export function messageRevokesDesistencia(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t) return false
  if (messageConfirmsProceedToInscricaoForm(text, [])) return true
  if (/\b(mudei\s+de\s+ideia|quero\s+sim|quero\s+me\s+inscrever|quero\s+matricular)\b/i.test(t)) return true
  if (/\b(outro\s+curso|outra\s+gradua)\b/i.test(t) && /\b(quero|gostaria)\b/i.test(t)) return true
  if (/\bfalar\s+com\s+(um\s+)?consultor\b/i.test(t)) return true
  return false
}

export function buildConfirmDesistenciaReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Entendi${nameBit}. Você *não deseja mesmo seguir* com a inscrição neste momento?\n\n` +
    `Temos diversos cursos que podem impulsionar a sua carreira — se quiser conhecer outra opção, ` +
    `posso te ajudar por aqui. Se preferir falar com um consultor, estamos à disposição.\n\n` +
    `Caso queira *confirmar a desistência* da inscrição, responda por aqui (por exemplo: *sim* ou *confirmo a desistência*).`
  )
}

export function buildDesistenciaAgradecimentoReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Obrigado pelo contato${nameBit}! Registramos sua desistência da inscrição. ` +
    `Qualquer outra dúvida sobre os cursos da Faculdade Sumaré, é só entrar em contato conosco por aqui. ` +
    `Será um prazer ajudar quando quiser.`
  )
}

/** Contexto mínimo para iniciar fluxo de desistência (sem status de matrícula ativo). */
export function shouldOfferDesistenciaConfirm(userMessage, historyMessages) {
  if (!conversationHadCourseEngagement(historyMessages)) return false
  if (!messageExpressesEnrollmentDecline(userMessage, historyMessages)) return false
  const lastAssist = lastAssistantText(historyMessages)
  if (assistantAskedDesistenciaConfirm(lastAssist)) return false
  return true
}
