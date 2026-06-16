/**
 * Pergunta sobre valor até o fim do curso / reajuste → resposta canônica
 * com mensalidade do curso em pauta (base de preços ou histórico).
 */

import {
  messageAsksPriceUntilCourseEnd,
  extractMensalidadeFromHistory,
  buildPriceUntilCourseEndReply,
} from '../libShared/priceDurationHeuristics.js'
import { extractDiscussedCourseFromHistory } from '../libShared/conversationContextHeuristics.js'
import { extractCursoAreaFromText } from '../libShared/cursoConfirmation.js'
import { lookupCursoPrecoResumo } from './inscricaoMatriculaConfirmFlow.js'

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
    priceDurationHandled: true,
  }
}

async function resolveMensalidade(env, { userMessage, historyMessages }) {
  const curso =
    extractDiscussedCourseFromHistory(historyMessages) ||
    extractCursoAreaFromText(userMessage) ||
    null
  if (curso) {
    const resumo = await lookupCursoPrecoResumo(env, curso).catch(() => null)
    if (resumo?.mensalidade) return { mensalidade: resumo.mensalidade, curso, source: 'preco_db' }
  }
  const fromHistory = extractMensalidadeFromHistory(historyMessages)
  if (fromHistory) return { mensalidade: fromHistory, curso, source: 'history' }
  const fromUser = extractMensalidadeFromHistory([{ role: 'user', content: userMessage }])
  if (fromUser) return { mensalidade: fromUser, curso, source: 'user_msg' }
  return { mensalidade: null, curso, source: 'none' }
}

export async function tryHandlePriceUntilCourseEndInquiry(env, ctx = {}) {
  const { userMessage, historyMessages, executionId, model, t0 } = ctx
  if (!messageAsksPriceUntilCourseEnd(userMessage, historyMessages)) return null

  const { mensalidade, curso, source } = await resolveMensalidade(env, {
    userMessage,
    historyMessages,
  })
  const reply = buildPriceUntilCourseEndReply({ mensalidade })

  console.log(
    `[${executionId}] PRICE_UNTIL_COURSE_END curso="${curso || 'n/a'}" valor="${mensalidade || 'n/a'}" source=${source} msg="${String(userMessage || '').slice(0, 80)}"`,
  )

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps: [
        {
          type: 'price_until_course_end',
          curso: curso || null,
          mensalidade: mensalidade || null,
          source,
          preview: String(userMessage || '').slice(0, 120),
        },
      ],
      ctxSnapshot: { priceUntilCourseEnd: true, curso: curso || null },
    }),
  }
}
