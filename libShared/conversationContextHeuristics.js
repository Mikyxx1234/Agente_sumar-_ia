/** Contexto de conversa (saudação no meio do atendimento, curso em discussão). */

import { normalizeMessageForScope } from './scopeHeuristics.js'
import { extractCursoAreaFromText } from './cursoConfirmation.js'

function isGreetingOnlyMessage(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim().replace(/[.!?]+$/, '')
  if (!t || t.length > 48) return false
  return /^(oi|ol[aá]|ola|bom dia|boa tarde|boa noite|e ai|e aí|hey|hello|hi)\b/.test(t)
}

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
  // Captura o NOME do curso logo após o enunciado do tópico
  // ("O curso de graduação em Redes de Computadores está disponível…"),
  // ignorando o grau (graduação/tecnólogo/…). O lookahead encerra no verbo/
  // preposição que segue o nome, então o nome composto é capturado inteiro.
  const introRe =
    /\bcurso\s+de\s+(?:(?:p[oó]s(?:-?\s*gradua[cç][aã]o)?|gradua[cç][aã]o|tecn[oó]logo|bacharelado|licenciatura)\s+(?:em\s+)?)?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{2,48}?)(?=\s+(?:est[aá]|dispon[ií]ve|é\b|tem\b|custa|no\b|na\b|com\b|por\b|\()|[,.?!\n]|$)/i
  for (let i = (historyMessages || []).length - 1; i >= 0; i--) {
    const m = historyMessages[i]
    if (m.role !== 'assistant' && m.role !== 'assistente') continue
    const content = String(m.content || '')
    const hit = content.match(introRe)
    if (hit?.[1]) {
      const name = hit[1].trim().replace(/\s+/g, ' ')
      // Normaliza para o nome canônico de um curso conhecido quando o trecho
      // capturado o contém (evita capturas tortas tipo "Direito não é ofertado").
      const canonical = extractCursoAreaFromText(name)
      if (canonical) return canonical
      if (name.length >= 3) return name
    }
    // Fallback: varre SOMENTE a 1ª frase (o enunciado do tópico), não a
    // descrição inteira — evita casar uma palavra de curso citada
    // incidentalmente na descrição de OUTRO curso (ex.: "administração" dentro
    // de "…foco em administração e segurança de redes…" para Redes de Computadores).
    const firstSentence = content.split(/(?<=[.!?\n])\s+/)[0] || content
    const area = extractCursoAreaFromText(firstSentence)
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
    /\b(fisioterapia|enfermagem|administra|pedagogia|direito|psicologia|engenharia|recursos\s+humanos|\brh\b|marketing|contabil|gest[aã]o|matr[ií]cula|inscri[cç][aã]o|formul[aá]rio|enem|vestibular|ingresso|mensalidade|gradua|ead|polo|polos|unidade|campus|pinheiros|faculdade|vila|zona|prudente|semipresencial|presencial)\b/i.test(
      blob,
    ) || /\bcurso\s+de\s+/i.test(blob)
  )
}

/** Lead já falou algo substantivo (não só saudação) nesta sessão de histórico. */
export function userHadSubstantiveTurnInHistory(historyMessages, excludeCurrentUserMessage = '') {
  const exclude = normalizeMessageForScope(excludeCurrentUserMessage).toLowerCase()
  for (const m of historyMessages || []) {
    if (m.role !== 'user' && m.role !== 'lead') continue
    const t = normalizeMessageForScope(m.content).toLowerCase()
    if (!t || t.length < 4) continue
    if (exclude && t === exclude) continue
    if (isGreetingOnlyMessage(m.content)) continue
    return true
  }
  return false
}

/**
 * Saudação contextual ("de onde paramos") só quando o lead já participou do assunto,
 * não quando o histórico é só eco do bot ou conversa anterior no mesmo telefone.
 */
export function shouldUseContextualGreetingReply(userMessage, historyMessages) {
  if (!isGreetingOnlyMessage(userMessage)) return false
  if (!userHadSubstantiveTurnInHistory(historyMessages, userMessage)) return false
  return conversationHasActiveTopic(historyMessages) || Boolean(extractDiscussedCourseFromHistory(historyMessages))
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
