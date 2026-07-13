/**
 * Inscrição/matrícula hoje com pagamento em data futura → resposta canônica institucional.
 */

import {
  messageAsksDeferredPaymentEnrollment,
  buildDeferredPaymentEnrollmentReply,
} from '../libShared/deferredPaymentEnrollmentHeuristics.js'

function buildAgentReturn({ executionId, model, t0, reply, pushName, steps }) {
  return {
    ok: true,
    reply,
    toolCalls: [],
    orchestratorSteps: steps || [],
    ctxSnapshot: { deferredPaymentEnrollment: true, pushName: pushName || null },
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    durationMs: Date.now() - t0,
    executionId,
    model,
    deferredPaymentEnrollmentHandled: true,
  }
}

export async function tryHandleDeferredPaymentEnrollmentFlow(env, ctx = {}) {
  const { userMessage, executionId, model, t0, pushName } = ctx
  if (!messageAsksDeferredPaymentEnrollment(userMessage)) return null

  const reply = buildDeferredPaymentEnrollmentReply({ pushName })

  console.log(
    `[${executionId}] DEFERRED_PAYMENT_ENROLLMENT msg="${String(userMessage || '').slice(0, 100)}"`,
  )

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      pushName,
      steps: [
        {
          type: 'deferred_payment_enrollment',
          preview: String(userMessage || '').slice(0, 120),
        },
      ],
    }),
  }
}
