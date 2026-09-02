/**
 * Perguntas sobre polos EAD, unidades por região/bairro e Central semipresencial.
 * Resposta canônica — evita recusa "fora do escopo" e omissão dos 5 polos.
 */

import { messageAsksRegionalFacultyLocation } from '../libShared/inboundMessageSanitize.js'
import { extractCursoAreaFromText } from '../libShared/cursoConfirmation.js'
import { buildPoloEadAndCentralInfoReply } from '../libShared/sumarePoloCatalog.js'

function buildAgentReturn({ executionId, model, t0, reply, pushName }) {
  return {
    ok: true,
    reply,
    toolCalls: [],
    orchestratorSteps: [{ type: 'polo_location_info', ok: true }],
    ctxSnapshot: { poloLocationInfo: true, pushName: pushName || null },
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    durationMs: Date.now() - t0,
    executionId,
    model,
    inscricaoFormHandled: false,
  }
}

/**
 * @returns {Promise<null | { handled: true, result: object }>}
 */
export async function tryHandlePoloLocationInfoFlow(env, input) {
  const { userMessage, executionId, model, pushName, t0, historyMessages = [] } = input || {}
  if (!String(userMessage || '').trim()) return null
  if (!messageAsksRegionalFacultyLocation(userMessage, historyMessages)) return null
  // Curso reconhecível → deixa o fluxo normal persistir o curso (não descartar)
  if (extractCursoAreaFromText(userMessage)) return null

  const reply = buildPoloEadAndCentralInfoReply({ pushName })
  console.log(
    `[poloLocationInfo] telefone=${input?.telefone ?? 'n/a'} lead=${input?.leadId ?? 'n/a'} ` +
      `msg="${String(userMessage || '').slice(0, 100).replace(/\n/g, ' ')}"`,
  )

  return {
    handled: true,
    result: buildAgentReturn({ executionId, model, t0, reply, pushName }),
  }
}
