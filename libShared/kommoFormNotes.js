/**
 * Helpers compartilhados — notas Kommo relacionadas ao Formulario_Sum.
 */

function noteBlob(n) {
  return [
    n?.params?.text,
    n?.params?.message,
    n?.text,
    typeof n?.params === 'object' ? JSON.stringify(n.params) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
}

function noteCreatedMs(n) {
  const c = n?.created_at ?? n?.date_create
  if (c == null) return 0
  if (typeof c === 'number') return c < 1e12 ? c * 1000 : c
  const t = Date.parse(c)
  return Number.isNaN(t) ? 0 : t
}

/** Última ativação do salesbot Formulario_Sum (epoch ms). */
export function findLastFormularioSumSentMs(notes) {
  let max = 0
  for (const n of notes || []) {
    const blob = noteBlob(n).toLowerCase()
    if (!blob.includes('formulario_sum')) continue
    if (!/\bativad[oa]\b|inscri[cç]/i.test(blob)) continue
    max = Math.max(max, noteCreatedMs(n))
  }
  return max
}

export { noteBlob, noteCreatedMs }
