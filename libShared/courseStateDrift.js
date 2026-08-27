/**
 * Detecta drift/troca de curso entre snapshot CRM (sum_Curso) e a conversa recente.
 * Puro: sem API/DB. Reusa extractCursoAreaFromText quando confiável.
 */

import { extractCursoAreaFromText } from './cursoConfirmation.js'

const RECENT_WINDOW = 12

/** Qualificadores de modalidade/grau — removidos na chave (não remove conectores do nome). */
const QUALIFIER_TOKENS = new Set([
  'ead',
  'semipresencial',
  'semi',
  'presencial',
  'online',
  'hibrido',
  'distancia',
  'bacharelado',
  'licenciatura',
  'tecnologo',
  'tecnologico',
  'graduacao',
  'pos',
  'posgraduacao',
  'mba',
  'especializacao',
  'superior',
])

/** Aliases mínimos já cobertos pelos padrões do projeto (RH / recursos humanos). */
const COURSE_KEY_ALIASES = new Map([
  ['rh', 'recursos humanos'],
  ['gestao de rh', 'recursos humanos'],
  ['gestao de pessoas', 'recursos humanos'],
  ['recursos humanos', 'recursos humanos'],
])

/**
 * Padrões locais para nomes que extractCursoAreaFromText não cobre
 * (ou cobriria mal) — sem inventar catálogo geral.
 * Ordem: mais específico primeiro (psicopedagogia antes de pedagogia).
 */
const LOCAL_COURSE_PATTERNS = [
  /\b(psicopedagogia)\b/i,
  /\b(gest[aã]o\s+de\s+rh)\b/i,
  /\b(gest[aã]o\s+de\s+recursos\s+humanos)\b/i,
]

function titleCaseCourse(text) {
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

function stripDiacriticsLower(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

const EDGE_GLUE_TOKENS = new Set(['em', 'de', 'da', 'do', 'das', 'dos', 'curso', 'cursos', 'na', 'no'])

/**
 * Chave canônica de curso: lowercase, sem diacríticos, whitespace colapsado,
 * qualificadores de modalidade/grau removidos.
 */
export function normalizeCourseKey(value) {
  const raw = stripDiacriticsLower(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!raw) return ''

  const tokens = raw.split(' ').filter((t) => t && !QUALIFIER_TOKENS.has(t))
  while (tokens.length && EDGE_GLUE_TOKENS.has(tokens[0])) tokens.shift()
  while (tokens.length && EDGE_GLUE_TOKENS.has(tokens[tokens.length - 1])) tokens.pop()

  let key = tokens.join(' ').trim()
  if (!key) return ''

  const aliased = COURSE_KEY_ALIASES.get(key)
  if (aliased) return aliased
  return key
}

/** Extrai nome de curso do texto (local + helper existente). */
export function extractCourseMention(text) {
  const raw = String(text || '')
  if (!raw.trim()) return ''

  for (const re of LOCAL_COURSE_PATTERNS) {
    const m = raw.match(re)
    if (m?.[1]) return titleCaseCourse(m[1])
  }

  const fromShared = extractCursoAreaFromText(raw)
  if (fromShared) return fromShared
  return ''
}

/**
 * True se `text` menciona o curso como tokens inteiros consecutivos
 * (não substring: Pedagogia ⊄ Psicopedagogia).
 */
export function textMentionsCourse(text, courseName) {
  const courseKey = normalizeCourseKey(courseName)
  if (!courseKey) return false
  const textKey = stripDiacriticsLower(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!textKey) return false

  const courseTokens = courseKey.split(' ').filter(Boolean)
  const textTokens = textKey.split(' ').filter(Boolean)
  if (!courseTokens.length || !textTokens.length) return false

  // Também tenta alias do texto bruto (ex.: "RH" no texto vs "recursos humanos")
  const textAsCourse = normalizeCourseKey(text)
  if (textAsCourse && textAsCourse === courseKey) return true

  outer: for (let i = 0; i <= textTokens.length - courseTokens.length; i++) {
    for (let j = 0; j < courseTokens.length; j++) {
      if (textTokens[i + j] !== courseTokens[j]) continue outer
    }
    return true
  }

  // Alias: tokens do texto normalizados via COURSE_KEY_ALIASES por janela
  for (let len = Math.min(4, textTokens.length); len >= 1; len--) {
    for (let i = 0; i <= textTokens.length - len; i++) {
      const slice = textTokens.slice(i, i + len).join(' ')
      if (COURSE_KEY_ALIASES.get(slice) === courseKey) return true
      if (normalizeCourseKey(slice) === courseKey) return true
    }
  }
  return false
}

function isUserRole(role) {
  const r = String(role || '').toLowerCase()
  return r === 'user' || r === 'lead'
}

function isAssistantRole(role) {
  const r = String(role || '').toLowerCase()
  return r === 'assistant' || r === 'assistente'
}

function recentSlice(historyMessages, max = RECENT_WINDOW) {
  const list = Array.isArray(historyMessages) ? historyMessages : []
  return list.slice(-max)
}

/**
 * Curso mais recente: userMessage → histórico (user/assistant) do mais novo ao mais antigo.
 */
function findMostRecentCourse(historyMessages, userMessage) {
  const fromUserMsg = extractCourseMention(userMessage)
  if (fromUserMsg) return fromUserMsg

  const recent = recentSlice(historyMessages)
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]
    if (!isUserRole(m?.role) && !isAssistantRole(m?.role)) continue
    const hit = extractCourseMention(m?.content)
    if (hit) return hit
  }
  return ''
}

function anyRoleMentions(historyMessages, courseName, rolePred) {
  const recent = recentSlice(historyMessages)
  for (const m of recent) {
    if (!rolePred(m?.role)) continue
    if (textMentionsCourse(m?.content, courseName)) return true
  }
  return false
}

function anyMessageMentions(historyMessages, courseName) {
  const recent = recentSlice(historyMessages)
  for (const m of recent) {
    if (textMentionsCourse(m?.content, courseName)) return true
  }
  return false
}

/**
 * @param {{
 *   historyMessages?: Array<{role?: string, content?: string}>,
 *   snapshotCurso?: string|null,
 *   inscricaoStage?: string|null,
 *   userMessage?: string|null,
 * }} opts
 * @returns {{
 *   switched: boolean,
 *   staleUnknown: boolean,
 *   previous: string|null,
 *   current: string|null,
 *   stageAtSwitch: string|null,
 *   confidence: 'high'|'medium'|'low',
 * }}
 */
export function detectCourseSwitchAgainstCrmState({
  historyMessages = [],
  snapshotCurso = null,
  inscricaoStage = null,
  userMessage = '',
} = {}) {
  const previousCourse = snapshotCurso ? String(snapshotCurso).trim() || null : null
  const previousKey = normalizeCourseKey(previousCourse)
  const recentCourse = findMostRecentCourse(historyMessages, userMessage) || null
  const recentKey = normalizeCourseKey(recentCourse)
  const stage = inscricaoStage != null && String(inscricaoStage).trim()
    ? String(inscricaoStage).trim()
    : null

  if (!previousKey) {
    return {
      switched: false,
      staleUnknown: false,
      previous: null,
      current: recentCourse,
      stageAtSwitch: stage,
      confidence: 'low',
    }
  }

  if (recentKey && previousKey && recentKey !== previousKey) {
    const asstMentionsNew = anyRoleMentions(historyMessages, recentCourse, isAssistantRole)
    const userConfirmsNew =
      anyRoleMentions(historyMessages, recentCourse, isUserRole) ||
      textMentionsCourse(userMessage, recentCourse)
    const confidence = asstMentionsNew && userConfirmsNew ? 'high' : 'medium'
    return {
      switched: true,
      staleUnknown: false,
      previous: previousCourse,
      current: recentCourse,
      stageAtSwitch: stage,
      confidence,
    }
  }

  if (!recentKey && previousKey) {
    const historyMentionsPrevious = anyMessageMentions(historyMessages, previousCourse)
    if (!historyMentionsPrevious) {
      return {
        switched: false,
        staleUnknown: true,
        previous: previousCourse,
        current: null,
        stageAtSwitch: stage,
        confidence: 'medium',
      }
    }
  }

  return {
    switched: false,
    staleUnknown: false,
    previous: previousCourse,
    current: recentCourse,
    stageAtSwitch: stage,
    confidence: 'high',
  }
}
