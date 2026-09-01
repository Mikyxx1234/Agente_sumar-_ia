/**
 * Links do site oficial Sumaré são para conferência interna (RAG) — não podem
 * ir ao lead, pois matrícula direta no site escapa da captação da empresa.
 *
 * Exceções permitidas ao lead: atendimento, ouvidoria, contrato/pagamento
 * (fluxo de inscrição via API Captação).
 */

const SUMare_URL_RX = /https?:\/\/(?:[a-z0-9-]+\.)*sumare\.edu\.br[^\s\])<>"]*/gi

const ALLOWED_URL_RX = [
  /\/atendimento\/?/i,
  /\/ouvidoria/i,
  /\/vem-pra-sumare\/vestibular\/contrato/i,
  /matricula\.sumare\.edu\.br\/vestibular\/(?:pagamento|termo-contrato)/i,
  /api-captacao\.sumare\.edu\.br/i,
]

function isAllowedSumareUrl(url) {
  return ALLOWED_URL_RX.some((rx) => rx.test(url))
}

/**
 * Remove URLs de curso/site da resposta ao lead. Mantém links institucionais
 * permitidos (atendimento, ouvidoria, contrato).
 *
 * @returns {{ text: string, removed: number }}
 */
export function sanitizeCourseLinksFromReply(text) {
  let out = String(text || '')
  let removed = 0
  out = out.replace(SUMare_URL_RX, (match) => {
    if (isAllowedSumareUrl(match)) return match
    removed += 1
    return ''
  })
  if (removed > 0) {
    out = out
      .replace(/\(\s*\)/g, '')
      .replace(/:\s*([.!?]|$)/gm, '$1')
      .replace(/acesse\s+(o\s+)?link\s*(abaixo)?\s*:?\s*/gi, '')
      .replace(/confira\s+(no\s+)?(site|link)\s*:?\s*/gi, '')
      .replace(/  +/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  return { text: out, removed }
}

export function replyContainsBlockedCourseLink(text) {
  const matches = String(text || '').match(SUMare_URL_RX) || []
  return matches.some((u) => !isAllowedSumareUrl(u))
}
