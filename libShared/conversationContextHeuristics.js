/** Contexto de conversa (saudação no meio do atendimento, curso em discussão). */

import { normalizeMessageForScope } from './scopeHeuristics.js'
import { extractCursoAreaFromText } from './cursoConfirmation.js'

function recentTranscript(historyMessages, max = 8) {
  return (historyMessages || []).slice(-max)
}

export function lastAssistantText(historyMessages) {
  const assistants = (historyMessages || []).filter((m) => m.role === 'assistant' || m.role === 'assistente')
  if (!assistants.length) return ''
  return String(assistants[assistants.length - 1].content || '')
}

/** Assistente perguntou se o lead quer seguir com matrícula/inscrição. */
export function assistantAskedEnrollmentInLastReply(historyMessages) {
  const a = lastAssistantText(historyMessages).toLowerCase()
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
    (/\b(estávamos|estavamos)\s+vendo\s+o\s+curso\b/i.test(a) &&
      /\b(matricul|inscri|continuar|dúvida)\b/i.test(a))
  )
}

/** Lead responde após pergunta sobre matrícula (ex.: áudio) — não tratar como pedido de consultor. */
export function userLikelyContinuingEnrollmentFlow(userMessage, historyMessages) {
  if (!assistantAskedEnrollmentInLastReply(historyMessages)) return false
  const t = normalizeMessageForScope(userMessage)
  return Boolean(t && t.length >= 1)
}

/** Lead reclama que já informou o curso/interesse ("eu já falei"). */
export function messageExpressesFrustrationAlreadySaid(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  return /\b(j[aá]\s+falei|eu\s+disse|j[aá]\s+disse|repeti|de\s+novo|falei\s+isso)\b/i.test(t)
}

export function extractDiscussedCourseFromHistory(historyMessages) {
  const re =
    /\bcurso\s+de\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{2,48}?)(?:\s+que|\s+no|\s+na|\?|\.|,|$)/i
  for (let i = (historyMessages || []).length - 1; i >= 0; i--) {
    const m = historyMessages[i]
    if (m.role !== 'assistant' && m.role !== 'assistente') continue
    const content = String(m.content || '')
    const hit = content.match(re)
    if (hit?.[1]) {
      const name = hit[1].trim().replace(/\s+/g, ' ')
      if (name.length >= 3) return name
    }
    const area = extractCursoAreaFromText(content)
    if (area) return area
  }
  return ''
}

const COURSE_FOLLOW_UP_RE =
  /\b(quero\s+saber|gostaria\s+de\s+saber|informa[cç][õo]es?\s+sobre|mais\s+sobre|novas?\s+informa[cç][õo]es|detalhes\s+sobre|falar\s+sobre|sobre\s+o\s+curso|esse\s+curso|o\s+curso\s+que|continuar|seguir)\b/i

/**
 * Lead continua o assunto de curso já aberto (ex.: "quero saber sobre recursos humanos"
 * depois que a IA citou RH na mensagem anterior).
 */
export function userMessageContinuesCourseDiscussion(userMessage, historyMessages = []) {
  const msg = normalizeMessageForScope(userMessage)
  if (!msg || msg.length < 4) return false

  const areaInMsg = extractCursoAreaFromText(msg)
  if (areaInMsg) return true

  const discussed = extractDiscussedCourseFromHistory(historyMessages)
  if (discussed && COURSE_FOLLOW_UP_RE.test(msg)) return true

  if (!conversationHasActiveTopic(historyMessages)) return false
  return COURSE_FOLLOW_UP_RE.test(msg) || /\b(sobre|desse|deste|dessa)\b/i.test(msg)
}

/** Já existe atendimento em andamento (não resetar com boas-vindas completas). */
export function conversationHasActiveTopic(historyMessages) {
  const msgs = recentTranscript(historyMessages, 10)
  if (msgs.length < 1) return false
  if (extractDiscussedCourseFromHistory(historyMessages)) return true

  const blob = msgs
    .map((m) => String(m.content || ''))
    .join('\n')
    .toLowerCase()

  if (extractCursoAreaFromText(blob)) return true

  return (
    /\b(fisioterapia|enfermagem|administra|pedagogia|direito|psicologia|engenharia|recursos\s+humanos|\brh\b|marketing|contabil|gest[aã]o|matr[ií]cula|inscri[cç][aã]o|formul[aá]rio|enem|vestibular|ingresso|mensalidade|gradua|ead)\b/i.test(
      blob,
    ) || /\bcurso\s+de\s+/i.test(blob)
  )
}

export function buildContextualGreetingReply(opts = {}) {
  const userMessage = opts.userMessage || ''
  const firstName = String(opts.pushName || '').trim().split(/\s+/)[0]
  const nameBit = firstName && firstName.length >= 2 && !/^\d+$/.test(firstName) ? `, ${firstName}` : ''

  const t = normalizeMessageForScope(userMessage).toLowerCase()
  let open = `Olá${nameBit}!`
  if (/^bom\s+dia/.test(t)) open = `Bom dia${nameBit}!`
  else if (/^boa\s+tarde/.test(t)) open = `Boa tarde${nameBit}!`
  else if (/^boa\s+noite/.test(t)) open = `Boa noite${nameBit}!`

  const course = extractDiscussedCourseFromHistory(opts.historyMessages)
  if (course) {
    return (
      `${open} Que bom falar com você de novo. ` +
      `Estávamos vendo o curso de ${course} — quer continuar com a matrícula, tirar alguma dúvida sobre esse curso ou prefere conhecer outras opções?`
    )
  }

  return (
    `${open} Que bom falar com você de novo. ` +
    'Posso seguir de onde paramos — quer informações sobre algum curso, valores ou ajuda com a matrícula?'
  )
}
