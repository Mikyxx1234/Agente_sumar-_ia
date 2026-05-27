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

/** Última ativação/envio do formulário Sumaré no Kommo (epoch ms). */
export function findLastFormularioSumSentMs(notes) {
  let max = 0
  for (const n of notes || []) {
    const blob = noteBlob(n).toLowerCase()
    const looksLikeFormSend =
      blob.includes('formulario_sum') ||
      /\bformul[aá]rio\b/.test(blob) ||
      /\bformulario\b/.test(blob)
    if (!looksLikeFormSend) continue
    if (!/\bativad[oa]\b|inscri[cç]|enviad[oa]|envio\b|salesbot|dados b[aá]sicos/i.test(blob)) {
      continue
    }
    max = Math.max(max, noteCreatedMs(n))
  }
  return max
}

export { noteBlob, noteCreatedMs }
