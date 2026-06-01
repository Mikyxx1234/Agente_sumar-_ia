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

/**
 * Última ativação/envio do formulário Sumaré no Kommo (epoch ms).
 *
 * `options.maxAgeMs` (opcional): ignora notas de envio mais antigas que essa
 * janela. Sem o cap, uma nota de formulário antiga (ex.: dias atrás) continua
 * servindo de âncora para detecções por evento de campo/snapshot, o que
 * re-dispara o pós-formulário sobre dados velhos (loop após reset). Por padrão
 * NÃO há cap (preserva o comportamento de quem só quer a última referência).
 */
export function findLastFormularioSumSentMs(notes, options = {}) {
  const maxAgeMs = Number(options.maxAgeMs)
  const hasCap = Number.isFinite(maxAgeMs) && maxAgeMs > 0
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
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
    const ms = noteCreatedMs(n)
    if (hasCap && ms && nowMs - ms > maxAgeMs) continue
    max = Math.max(max, ms)
  }
  return max
}

export { noteBlob, noteCreatedMs }
