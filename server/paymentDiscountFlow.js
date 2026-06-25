/**
 * Pergunta sobre desconto / pagamento antecipado → resposta canônica institucional.
 */

import {
  messageAsksPaymentDiscount,
  buildPaymentDiscountReply,
} from '../libShared/paymentDiscountHeuristics.js'

function buildAgentReturn({ executionId, model, t0, reply, steps, ctxSnapshot, ok = true }) {
  return {
    ok,
    reply,
    toolCalls: [],
    orchestratorSteps: steps || [],
    ctxSnapshot: ctxSnapshot || {},
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    durationMs: Date.now() - t0,
    executionId,
    model,
    paymentDiscountHandled: true,
  }
}

export async function tryHandlePaymentDiscountInquiry(env, ctx = {}) {
  const { userMessage, executionId, model, t0 } = ctx
  if (!messageAsksPaymentDiscount(userMessage)) return null

  const reply = buildPaymentDiscountReply()

  console.log(
    `[${executionId}] PAYMENT_DISCOUNT msg="${String(userMessage || '').slice(0, 80)}"`,
  )

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps: [{ type: 'payment_discount', preview: String(userMessage || '').slice(0, 120) }],
      ctxSnapshot: { paymentDiscount: true },
    }),
  }
}
