/** Contexto de conversa (saudação no meio do atendimento, curso em discussão). */

import { normalizeMessageForScope } from './scopeHeuristics.js'

function recentTranscript(historyMessages, max = 8) {
  return (historyMessages || []).slice(-max)
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
  }
  return ''
}

/** Já existe atendimento em andamento (não resetar com boas-vindas completas). */
export function conversationHasActiveTopic(historyMessages) {
  const msgs = recentTranscript(historyMessages, 10)
  if (msgs.length < 2) return false

  const blob = msgs
    .map((m) => String(m.content || ''))
    .join('\n')
    .toLowerCase()

  return (
    /\b(fisioterapia|enfermagem|administra|pedagogia|direito|psicologia|engenharia|matr[ií]cula|inscri[cç][aã]o|formul[aá]rio|enem|vestibular|ingresso|mensalidade|gradua)\b/i.test(
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
