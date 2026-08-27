/**
 * Desconto por pagamento antecipado da mensalidade (70% / 50% / 20% conforme o dia).
 */

import { messageAsksPaymentInfo, messageAsksPaymentMethodOptions } from './inboundMessageSanitize.js'
import { messageAsksPriceUntilCourseEndInText } from './priceDurationHeuristics.js'

/** Lead pergunta sobre desconto na mensalidade / pagamento antecipado. */
export function messageAsksPaymentDiscount(text) {
  if (!messageAsksPaymentInfo(text)) return false
  // "quais são as formas de pagamento" (boleto/PIX/cartão) é FAQ institucional própria —
  // não é pergunta de desconto por pagamento antecipado.
  if (messageAsksPaymentMethodOptions(text)) return false
  // "desconto até o fim do curso" / reajuste — fluxo dedicado (priceDurationFlow).
  if (messageAsksPriceUntilCourseEndInText(text)) return false
  return true
}

/** Resposta canônica do Plano de Benefício para Pagamento Antecipado Facultativo. */
export function buildPaymentDiscountReply() {
  return (
    'Sim! A mensalidade tem *desconto por pagamento antecipado facultativo* — quanto antes você paga no mês, maior o benefício:\n\n' +
    '• *1º dia do mês:* 70% de desconto\n' +
    '• *2º ao 5º dia:* 50% de desconto (inclui sábado)\n' +
    '• *6º ao 10º dia:* 20% de desconto\n\n' +
    'Após o dia 10 do mês de referência, *não há* desconto antecipado naquela mensalidade.\n\n' +
    'Se você mantiver o pagamento no 1º dia de cada mês, o desconto máximo (70%) se repete *todo mês* na mensalidade daquele mês.'
  )
}
