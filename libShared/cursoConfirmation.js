/**
 * Detecta quando o candidato CONFIRMA interesse num curso específico
 * durante a conversa. Usado para popular o campo sum_Curso no Kommo
 * antes do formulário/matrícula.
 */

import { normalizeMessageForScope } from './scopeHeuristics.js'
import { extractDiscussedCourseFromHistory } from './conversationContextHeuristics.js'

const STOP_WORDS = new Set([
  'esse', 'essa', 'isso', 'sim', 'nao', 'não', 'ok', 'okay', 'matricula',
  'matrícula', 'inscricao', 'inscrição', 'curso', 'cursos', 'faculdade',
  'sumare', 'sumaré', 'agora', 'voce', 'você', 'eu', 'que', 'pode',
  'bora', 'vamos', 'ai', 'aí', 'me', 'um', 'uma', 'o', 'a', 'de', 'do', 'da',
])

const CURSO_PATTERNS = [
  /\b(fisioterapia)\b/i,
  /\b(enfermagem)\b/i,
  /\b(administra[cç][aã]o|administração)\b/i,
  /\b(pedagogia)\b/i,
  /\b(direito)\b/i,
  /\b(psicologia)\b/i,
  /\b(engenharia\s+(?:civil|de\s+produ[cç][aã]o|el[eé]trica|mec[aâ]nica|computa[cç][aã]o|software|de\s+software)?)\b/i,
  /\b(arquitetura(?:\s+e\s+urbanismo)?)\b/i,
  /\b(nutri[cç][aã]o)\b/i,
  /\b(farm[aá]cia)\b/i,
  /\b(biomedicina)\b/i,
  /\b(odontologia)\b/i,
  /\b(medicina(?:\s+veterin[aá]ria)?)\b/i,
  /\b(gastronomia)\b/i,
  /\b(ci[eê]ncias?\s+(?:cont[aá]beis|econ[oô]micas|biol[oó]gicas|sociais|da\s+computa[cç][aã]o))\b/i,
  /\b(economia)\b/i,
  /\b(contabilidade|contabeis|cont[aá]beis)\b/i,
  /\b(marketing(?:\s+digital)?)\b/i,
  /\b(publicidade(?:\s+e\s+propaganda)?)\b/i,
  /\b(jornalismo)\b/i,
  /\b(letras|hist[oó]ria|geografia|filosofia|sociologia|matem[aá]tica|f[ií]sica|qu[ií]mica|biologia)\b/i,
  /\b(rh|recursos\s+humanos|gest[aã]o\s+de\s+pessoas)\b/i,
  /\b(log[ií]stica|gest[aã]o\s+comercial|gest[aã]o\s+financeira|com[eé]rcio\s+exterior)\b/i,
  /\b(an[aá]lise\s+e?\s+desenvolvimento\s+de\s+sistemas|ads)\b/i,
  /\b(redes\s+de\s+computadores|seguran[cç]a\s+da\s+informa[cç][aã]o)\b/i,
  /\b(servi[cç]o\s+social)\b/i,
  /\b(educa[cç][aã]o\s+f[ií]sica)\b/i,
  /\b(est[eé]tica(?:\s+e\s+cosm[eé]tica)?)\b/i,
]

function titleCase(text) {
  return String(text)
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => {
      if (!/[a-zà-ÿ]/i.test(part)) return part
      if (['de', 'da', 'do', 'das', 'dos', 'e'].includes(part)) return part
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

const CURSO_NAME_STOP_TOKENS = new Set([
  'tem', 'é', 'fica', 'custa', 'esta', 'está', 'sai', 'com', 'por',
  'que', 'no', 'na', 'nos', 'nas', 'em', 'para', 'pra',
  'também', 'tambem', 'incluso', 'presencial', 'ead', 'semi',
  'online', 'noturno', 'matutino', 'integral', 'vagas', 'vaga',
  'polo', 'polos', 'mensalidade', 'mensalidades', 'preço', 'preco',
  'valor', 'valores', 'graduação', 'graduacao', 'graduacão',
  'tecnologo', 'tecnólogo', 'bacharel', 'licenciatura', 'whatsapp',
])

/**
 * Corta o nome no primeiro token "de lixo" (verbo/modalidade/preço…).
 * Mantém conectivos `e/de/da/do/das/dos` para nomes compostos como
 * "Análise e Desenvolvimento de Sistemas". Limita a 5 tokens.
 */
function sanitizeCursoName(rawName) {
  if (!rawName) return ''
  const text = String(rawName).trim().replace(/[.,;:!?]+$/g, '')
  const tokens = text.split(/\s+/).filter(Boolean)
  const kept = []
  for (const tok of tokens) {
    const t = tok.toLowerCase()
    if (CURSO_NAME_STOP_TOKENS.has(t)) break
    kept.push(tok)
    if (kept.length >= 5) break
  }
  if (kept.length === 0) return ''
  const limited = kept.join(' ')
  if (limited.length < 3) return ''
  if (STOP_WORDS.has(limited.toLowerCase())) return ''
  return titleCase(limited)
}

/** Nome de área/curso citado no texto (ex.: "recursos humanos", "marketing"). */
export function extractCursoAreaFromText(text) {
  const raw = String(text || '')
  for (const re of CURSO_PATTERNS) {
    const m = raw.match(re)
    if (m?.[1]) return titleCase(m[1])
  }
  return ''
}

function extractCursoFromText(text) {
  return extractCursoAreaFromText(text)
}

function userExpressesInterest(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t) return false
  return (
    /\b(quero|gostaria|gostei|vou\s+fazer|pretendo|preciso|posso\s+fazer|tenho\s+interesse)\b/i.test(t) ||
    /\b(me\s+inscrev|matricul|inscri[cç][aã]o)\b/i.test(t) ||
    /\b(esse|essa|isso)\s+curso\b/i.test(t)
  )
}

function userConfirmsShortReply(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim()
  if (!t || t.length > 40) return false
  return /^\s*(sim|s|quero|pode|bora|vamos|ok|gostei|isso|esse\s+curso|fazer)\b/i.test(t)
}

function lastAssistantMentionedCurso(historyMessages) {
  const list = historyMessages || []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.role !== 'assistant' && m.role !== 'assistente') continue
    const content = String(m.content || '').toLowerCase()
    if (/\bcurso\s+de\s+/i.test(content) || /\b(matricul|inscri|ingressar|vestibular)\b/i.test(content)) {
      return true
    }
    break
  }
  return false
}

/**
 * Retorna o nome do curso confirmado pelo lead nesta mensagem (ou string vazia).
 *
 * Cobre:
 *  - "quero fazer Fisioterapia" / "gostei de Administração" (curso explícito no texto)
 *  - "quero esse curso", "sim", "gostei" — quando o último turno do assistente
 *    já discutia um curso identificável no histórico.
 */
export function detectCursoConfirmadoPeloLead(userMessage, historyMessages) {
  if (!userMessage) return ''
  const direct = extractCursoFromText(userMessage)
  if (direct && userExpressesInterest(userMessage)) return sanitizeCursoName(direct)
  if (direct && lastAssistantMentionedCurso(historyMessages)) return sanitizeCursoName(direct)

  if (userExpressesInterest(userMessage) || userConfirmsShortReply(userMessage)) {
    const fromHist = extractDiscussedCourseFromHistory(historyMessages)
    if (fromHist) return sanitizeCursoName(fromHist)
  }
  return ''
}

export const __test = { extractCursoFromText, userExpressesInterest, titleCase, sanitizeCursoName }
