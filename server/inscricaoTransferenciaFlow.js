/**
 * Transferência externa: completa dados pendentes de forma determinística
 * quando o lead responde o semestre após o agente pedir (TRANSFERENCIA_DADOS_FALTANDO).
 */

import { lastAssistantText } from '../libShared/inscricaoFormHeuristics.js'
import { runRegistrarTransferencia } from './inscricaoActionTools.js'
import { maybeAuditActionToolFailure } from './inscricaoFailureAudit.js'

const TRANSFERENCIA_PEDIDO_RX =
  /transfer[eê]ncia\/aproveitamento de mat[eé]rias/i

const SEMESTRE_PEDIDO_RX =
  /(?:me confirme|último semestre|semestre conclu[ií]do)/i

const ORDINAL_TO_NUM = {
  primeiro: '1',
  primeira: '1',
  segundo: '2',
  segunda: '2',
  terceiro: '3',
  terceira: '3',
  quarto: '4',
  quarta: '4',
  quinto: '5',
  quinta: '5',
  sexto: '6',
  sexta: '6',
  setimo: '7',
  sétimo: '7',
  setima: '7',
  sétima: '7',
  oitavo: '8',
  oitava: '8',
  nono: '9',
  nona: '9',
  decimo: '10',
  décimo: '10',
}

function buildAgentReturn({ executionId, model, t0, reply, steps, toolCalls, ctxSnapshot, ok = true }) {
  return {
    ok,
    reply,
    toolCalls: toolCalls || [],
    orchestratorSteps: steps || [],
    ctxSnapshot: ctxSnapshot || {},
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    durationMs: Date.now() - t0,
    executionId,
    model,
    inscricaoFormHandled: true,
  }
}

export function assistantAskedTransferenciaDadosPendentes(assistantText) {
  const t = String(assistantText || '')
  if (!t) return false
  return TRANSFERENCIA_PEDIDO_RX.test(t) && SEMESTRE_PEDIDO_RX.test(t)
}

export function parseSemestreFromUserMessage(message) {
  const raw = String(message || '').trim()
  if (!raw) return null
  const norm = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

  for (const [word, num] of Object.entries(ORDINAL_TO_NUM)) {
    if (norm.includes(word)) return num
  }

  const digit = norm.match(/\b(\d{1,2})\b/)
  if (digit) return digit[1]

  if (/^\d{1,2}$/.test(norm.replace(/\D/g, ''))) return norm.replace(/\D/g, '')
  return null
}

export function parseTransferenciaIntentFromText(text) {
  const t = String(text || '').trim()
  if (!t) return null

  const patterns = [
    /(?:cursando|cursava|cursar|estudo|estudando|estava\s+cursando)\s+(.+?)\s+e\s+quero\s+(?:fazer|cursar|estudar|continuar(?:\s+com)?|mudar\s+para)\s+(?:curso\s+(?:de|em)\s+)?(.+)$/i,
    /(?:quero|gostaria\s+de)\s+(?:fazer|cursar|estudar|continuar(?:\s+com)?)\s+(?:curso\s+(?:de|em)\s+)?(.+?)\s+(?:aproveitando|transferindo|vindo)\s+(?:de|do|da)\s+(.+)$/i,
    /(?:transferir|mudar|trocar)\s+(?:de\s+)?(.+?)\s+para\s+(.+)$/i,
    /(?:sai\s+de|saindo\s+de|vim\s+de)\s+(.+?)\s+(?:e\s+)?(?:quero|vou)\s+(?:fazer|cursar)\s+(.+)$/i,
  ]

  for (const rx of patterns) {
    const m = t.match(rx)
    if (m?.[1] && m?.[2]) {
      return { origem: m[1].trim(), destino: m[2].trim() }
    }
  }
  return null
}

export function extractTransferenciaFromHistory(historyMessages = []) {
  const users = [...historyMessages].reverse().filter((m) => m?.role === 'user')
  for (const m of users) {
    const parsed = parseTransferenciaIntentFromText(m.content)
    if (parsed?.origem && parsed?.destino) return parsed
  }
  return null
}

/**
 * Lead respondeu semestre após pedido de dados de transferência → completa e chama registrar_transferencia.
 */
export async function tryHandleTransferenciaDadosPendentes(env, ctx = {}) {
  const { telefone, userMessage, historyMessages = [], executionId, model, t0, leadId, pushName } = ctx
  if (!telefone || !userMessage) return null

  const lastAssist = lastAssistantText(historyMessages)
  if (!assistantAskedTransferenciaDadosPendentes(lastAssist)) return null

  const semestre = parseSemestreFromUserMessage(userMessage)
  if (!semestre) return null

  const extracted = extractTransferenciaFromHistory(historyMessages)
  if (!extracted?.origem || !extracted?.destino) return null

  console.log(
    `[${executionId}] TRANSFERENCIA_AUTO_COMPLETE origem="${extracted.origem}" destino="${extracted.destino}" semestre=${semestre}`,
  )

  const flowCtx = { telefone, leadId, pushName, executionId, model, historyMessages, t0 }
  const result = await runRegistrarTransferencia(
    env,
    {
      telefone,
      curso_origem: extracted.origem,
      semestre_concluido: semestre,
      curso_desejado: extracted.destino,
    },
    flowCtx,
  )
  await maybeAuditActionToolFailure(env, flowCtx, result)

  const reply = result.replyOverride || result.text
  if (!reply) return null

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps: [
        { type: 'transferencia_auto_complete', ok: Boolean(result.ok), code: result.code },
        ...(result.steps || []),
      ],
      toolCalls: [{ tool: 'registrar_transferencia', ok: Boolean(result.ok), code: result.code }],
      ctxSnapshot: {
        ...(result.ctxSnapshot || {}),
        replySource: 'transferencia_auto_complete',
        transferenciaAutoComplete: true,
      },
    }),
  }
}
