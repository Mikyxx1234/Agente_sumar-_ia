/**
 * Detecção de nível (grad vs pós) para grade curricular e auto-send.
 */

/** Lead nega pós/MBA — prioridade sobre menção incidental de "pós". */
export function messageDeniesPos(text) {
  const t = String(text || '').toLowerCase()
  return (
    /\bn[ãa]o\s+[ée]\s+p[oó]s\b/.test(t) ||
    /\bn[ãa]o\s+quero\s+p[oó]s\b/.test(t) ||
    /\bn[ãa]o\s+[ée]\s+mba\b/.test(t) ||
    /\bn[ãa]o\s+[ée]\s+especializa/.test(t)
  )
}

/** Lead nega graduação — quer pós. */
export function messageDeniesGrad(text) {
  const t = String(text || '').toLowerCase()
  return /\bn[ãa]o\s+[ée]\s+gradua/.test(t)
}

/** Correção explícita de nível (ex.: "não é pós, é graduação"). */
export function isNivelCorrectionMessage(text) {
  const t = String(text || '').toLowerCase()
  if (messageDeniesPos(t) && /\b(gradua|bacharel|licenciatura|tecn[oó]log)\b/.test(t)) return true
  if (messageDeniesGrad(t) && /\b(p[oó]s|mba|especializa)\b/.test(t)) return true
  return messageDeniesPos(t) || messageDeniesGrad(t)
}

/**
 * @param {{ curso?: string, userMessage?: string, kommoCurso?: string, kommoModalidade?: string }} input
 * @returns {'grad'|'pos'|null}
 */
export function detectNivel({ curso, userMessage, kommoCurso, kommoModalidade } = {}) {
  const blob = `${curso || ''} ${userMessage || ''} ${kommoCurso || ''}`.toLowerCase()

  if (messageDeniesPos(blob)) return 'grad'
  if (messageDeniesGrad(blob)) return 'pos'

  const wantsGrad =
    /\b(gradua|bacharel|licenciatura|tecn[oó]log\w*|tecnologia)\b/i.test(blob)
  const wantsPos = /\b(p[oó]s[\s-]?grad|mba|especializa|lato\s+sensu)\b/i.test(blob)

  if (wantsGrad && wantsPos) {
    if (/\b[ée]\s+gradua/.test(blob) || /\b[ée]\s+tecn[oó]log/.test(blob)) return 'grad'
    if (/\b[ée]\s+p[oó]s/.test(blob) || /\b[ée]\s+mba/.test(blob)) return 'pos'
  }

  if (wantsPos) return 'pos'
  if (wantsGrad) return 'grad'

  return null
}

/** Curso arg contém MBA/pós mas nível detectado é grad (ou vice-versa). */
export function nivelConflictsWithCursoName(cursoName, nivel) {
  const n = String(cursoName || '').toLowerCase()
  if (!nivel) return false
  const looksPos = /\b(mba|p[oó]s|especializa|lato\s+sensu)\b/i.test(n)
  const looksGrad = /\b(bacharel|licenciatura|tecn[oó]log)\b/i.test(n)
  if (nivel === 'grad' && looksPos && !looksGrad) return true
  if (nivel === 'pos' && looksGrad && !looksPos) return true
  return false
}
