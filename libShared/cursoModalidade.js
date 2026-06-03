/**
 * Mapeamento modalidade ↔ turno da API Captação Sumaré.
 *
 * Confirmado por sondagem na API (03/06):
 *   - EAD            → curso `_EAD`  + turno=EAD
 *   - Semipresencial → curso `_SEMI` + turno=SEMIPRESENCIAL
 * Combinar a modalidade errada (ex.: código `_EAD` com turno EAD para um curso
 * que só é ofertado Semipresencial) faz o financeiro nascer nulo no Lyceum
 * (HTTP 500 "Cannot insert NULL into CANDIDATO") → portal mostra "R$ null/mês".
 */

export const TURNO_EAD = 'EAD'
export const TURNO_SEMIPRESENCIAL = 'SEMIPRESENCIAL'

/** Normaliza rótulo de modalidade vindo da planilha/catálogo. */
export function normalizeModalidade(modalidade) {
  const m = String(modalidade || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
  if (!m) return ''
  if (m === 'ead' || m.includes('distancia') || m.includes('a distancia')) return 'EAD'
  if (m.includes('semi')) return 'Semipresencial'
  if (m.includes('presencial')) return 'Presencial'
  return ''
}

/** Turno da API correspondente à modalidade. */
export function modalidadeToTurno(modalidade) {
  const m = normalizeModalidade(modalidade)
  if (m === 'Semipresencial') return TURNO_SEMIPRESENCIAL
  if (m === 'EAD') return TURNO_EAD
  return ''
}

/**
 * Deriva o turno a partir do sufixo do código do curso (ex.: FARM_SEMI → SEMIPRESENCIAL).
 * Fallback usado quando não há modalidade explícita.
 */
export function turnoFromCursoCodigo(codigo) {
  const c = String(codigo || '').trim().toUpperCase()
  if (!c) return ''
  if (/_SEMI(?:_|$)/.test(c) || /_SEMI\d*$/.test(c)) return TURNO_SEMIPRESENCIAL
  if (/_EAD(?:_|$)/.test(c) || /_EAD$/.test(c)) return TURNO_EAD
  return ''
}

/** Modalidade implícita pelo sufixo do código (inverso de turnoFromCursoCodigo). */
export function modalidadeFromCursoCodigo(codigo) {
  const c = String(codigo || '').trim().toUpperCase()
  if (/_SEMI(?:_|\d*$|$)/.test(c)) return 'Semipresencial'
  if (/_EAD(?:_|$)/.test(c)) return 'EAD'
  return ''
}
