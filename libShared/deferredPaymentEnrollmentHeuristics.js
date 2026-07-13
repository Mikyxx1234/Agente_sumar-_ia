/**
 * Lead quer iniciar inscrição/matrícula agora, mas pagar em data futura.
 */

import { normalizeMessageForScope } from './scopeHeuristics.js'

/** Lead pergunta se pode fazer o processo hoje e pagar depois (ex.: dia 30). */
export function messageAsksDeferredPaymentEnrollment(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 20) return false

  const paymentLater =
    /\b(s[oó]\s+(vou|posso|consigo)\s+pagar|pagar\s+(s[oó]|apenas|somente|no\s+dia|dia\s+\d|depois|mais\s+tarde|posteriormente)|pagamento\s+(no\s+dia|dia\s+\d|depois|posterior|mais\s+tarde)|executar\s+o\s+pagamento|ter\s+(um\s+)?valor\s+(s[oó]|no\s+dia|dia\s+\d))\b/i.test(
      t,
    ) ||
    /\b(daqui\s+a\s+\d+\s+dias?|no\s+dia\s+\d{1,2}(?:\s+deste\s+m[eê]s)?)\b/i.test(t)

  const enrollmentNow =
    /\b(fazer\s+(todo\s+)?(o\s+)?processo|garantir\s+(a\s+)?vaga|matr[ií]cula|inscri[cç][aã]o|fechamos|libera[cç][aã]o\s+do\s+curso|processo\s+hoje|processo\s+hj)\b/i.test(
      t,
    )

  if (paymentLater && enrollmentNow) return true
  if (/\bvalor\s+promocional\b/i.test(t) && paymentLater) return true

  return false
}

/** Resposta canônica — matrícula só na data do pagamento; valores podem mudar. */
export function buildDeferredPaymentEnrollmentReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Entendo${nameBit}! Como o pagamento será executado em uma data posterior, os valores podem sofrer alterações ` +
    `por decisões internas da Faculdade Sumaré.\n\n` +
    `Mesmo assim, faremos o possível para garantir o valor promocional que combinamos.\n\n` +
    `Quando você estiver pronto(a) para efetuar o pagamento, é só entrar em contato por aqui — ` +
    `realizamos sua matrícula naquele momento. Não é necessário concluir todo o processo hoje sem o pagamento.`
  )
}
