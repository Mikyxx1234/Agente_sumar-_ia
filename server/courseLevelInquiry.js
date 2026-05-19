/**
 * Lead pergunta por curso técnico (não ofertado) → explica e sugere graduação na mesma área (RAG).
 */

import { createExecutionContext } from './ai/executionContext.js'
import { searchKnowledgeBase } from './ai/knowledgeSearch.js'
import {
  messageAsksUnsupportedCourseLevel,
  buildTechnicalCourseSearchQuery,
  buildUnsupportedCourseLevelReply,
} from '../libShared/courseLevelHeuristics.js'

export async function tryHandleUnsupportedCourseLevelInquiry(env, input) {
  const { userMessage, historyMessages, executionId, model, pushName, t0 } = input
  if (!messageAsksUnsupportedCourseLevel(userMessage)) return null

  const ctx = createExecutionContext()
  const query = buildTechnicalCourseSearchQuery(userMessage)
  let searchText = ''
  try {
    searchText = await searchKnowledgeBase(env, ctx, query, {
      toolName: 'buscar_informacoes',
      levelHint: 'grad',
      intentHint: 'info',
    })
  } catch (err) {
    console.warn(`[courseLevelInquiry] RAG falhou: ${err.message}`)
  }

  const reply = buildUnsupportedCourseLevelReply({
    userMessage,
    searchText,
    pushName,
  })

  return {
    handled: true,
    result: {
      ok: true,
      reply,
      toolCalls: [
        {
          tool: 'buscar_informacoes',
          args: { query },
          result: searchText?.slice(0, 400) || 'sem resultados',
          ok: Boolean(searchText && !searchText.includes('Nenhum resultado')),
        },
      ],
      orchestratorSteps: [{ type: 'curso_tecnico_alternativa', query, durationMs: Date.now() - t0 }],
      ctxSnapshot: { unsupportedCourseLevel: true, ragQuery: query },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      durationMs: Date.now() - t0,
      executionId,
      model,
      inscricaoFormHandled: false,
      aiMeta: ctx.toAiMeta(),
    },
  }
}
