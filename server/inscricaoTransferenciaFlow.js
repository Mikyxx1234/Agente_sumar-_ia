/**
 * Transferência externa / aproveitamento de matérias — handlers determinísticos
 * para não perder origem, destino e semestre já informados no histórico.
 */

import { normalizeMessageForScope } from '../libShared/scopeHeuristics.js'
import { extractCursoAreaFromText } from '../libShared/cursoConfirmation.js'
import { lastAssistantText } from '../libShared/inscricaoFormHeuristics.js'
import { runRegistrarTransferencia } from './inscricaoActionTools.js'
import { maybeAuditActionToolFailure } from './inscricaoFailureAudit.js'

const TRANSFERENCIA_PEDIDO_RX =
  /transfer[eê]ncia|aproveitamento\s+de\s+(mat[eé]rias|disciplinas)/i

const SEMESTRE_PEDIDO_RX =
  /(?:me confirme|último semestre|semestre conclu[ií]do|semestre cursado)/i

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

function cleanCursoLabel(raw) {
  return String(raw || '')
    .replace(/\s+da\s+Faculdade\s+Sumar[eé].*/i, '')
    .replace(/\s+na\s+Sumar[eé].*/i, '')
    .replace(/\s+da\s+Sumar[eé].*/i, '')
    .replace(/[.,;:!?]+$/, '')
    .trim()
}

function normalizeRole(role) {
  return role === 'assistente' ? 'assistant' : role
}

export function conversationMentionsTransferencia(historyMessages = []) {
  const blob = (historyMessages || [])
    .map((m) => String(m.content || ''))
    .join('\n')
    .toLowerCase()
  return TRANSFERENCIA_PEDIDO_RX.test(blob) || /ingressar\s+no\s+.+\s+aproveit/i.test(blob)
}

export function assistantAskedTransferenciaDadosPendentes(assistantText) {
  const t = String(assistantText || '')
  if (!t) return false
  if (TRANSFERENCIA_PEDIDO_RX.test(t) && SEMESTRE_PEDIDO_RX.test(t)) return true
  if (
    /qual\s+(?:é|era)\s+o\s+curso\b/i.test(t) &&
    /(?:cursava|cursou|faculdade|institui[cç][aã]o|anterior)/i.test(t) &&
    SEMESTRE_PEDIDO_RX.test(t)
  ) {
    return true
  }
  if (/curso\s+que\s+voc[eê]\s+(?:cursava|cursou)/i.test(t) && SEMESTRE_PEDIDO_RX.test(t)) {
    return true
  }
  return false
}

export function assistantAskedTransferenciaConfirmacao(assistantText) {
  const t = String(assistantText || '')
  if (!t) return false
  if (!/aproveitar\s+(?:as\s+)?disciplinas/i.test(t) && !/só\s+para\s+confirmar/i.test(t)) {
    return false
  }
  return (
    /\bcerto\??/i.test(t) ||
    /para\s+ingressar\s+no/i.test(t) ||
    (/deseja\b/i.test(t) && /ingressar/i.test(t))
  )
}

export function messageConfirmsTransferencia(userMessage) {
  const t = normalizeMessageForScope(userMessage).toLowerCase().trim().replace(/[.!?]+$/, '')
  if (!t || t.length > 40) return false
  return /^(sim|s|isso|correto|confirmo|pode ser|ok|certo|exato)\b/i.test(t)
}

export function parseSemestreFromUserMessage(message) {
  const raw = String(message || '').trim()
  if (!raw) return null
  const norm = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

  const yearMatch =
    norm.match(/(?:último\s+semestre|semestre\s+conclu[ií]do|semestre\s+cursado)\s*(?:de\s+)?(\d{4})\b/i) ||
    norm.match(/\bsemestre\s+de\s+(\d{4})\b/i)
  if (yearMatch?.[1]) return yearMatch[1]

  for (const [word, num] of Object.entries(ORDINAL_TO_NUM)) {
    if (norm.includes(word)) return num
  }

  const semMatch = norm.match(
    /(?:último\s+semestre|semestre\s+conclu[ií]do|semestre\s+cursado)\s*(?:de\s+)?(\d{1,2})\b/i,
  )
  if (semMatch?.[1]) return semMatch[1]

  const digit = norm.match(/\b(\d{1,2})\b/)
  if (digit) return digit[1]

  if (/^\d{1,4}$/.test(norm.replace(/\D/g, ''))) return norm.replace(/\D/g, '')
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
      return { origem: cleanCursoLabel(m[1]), destino: cleanCursoLabel(m[2]) }
    }
  }
  return null
}

export function extractOrigemSemestreFromUserText(text) {
  const raw = String(text || '').trim()
  if (!raw) return null

  let origem = null
  const origemPatterns = [
    /(?:^|[.;]\s*)(?:licenciatura|bacharelado|tecn[oó]logo)\s+em\s+(.+?)(?:\s*\.|\s*,|\s*último|$)/i,
    /(?:cursava|cursando|estudei|fiz|curso)\s+(?:licenciatura|bacharelado|tecn[oó]logo)?\s*(?:em\s+)?(.+?)(?:\s*\.|\s*,|\s*último|$)/i,
  ]
  for (const rx of origemPatterns) {
    const m = raw.match(rx)
    if (m?.[1]) {
      origem = cleanCursoLabel(m[1])
      break
    }
  }

  const semestre = parseSemestreFromUserMessage(raw)
  if (!origem && !semestre) return null
  return { origem, semestre }
}

export function extractTransferenciaConfirmacaoFromAssistant(text) {
  const t = String(text || '')
  const patterns = [
    /disciplinas\s+da\s+(.+?)\s+(?:que\s+)?(?:cursou|cursava|fez).*?(?:para\s+)?ingressar\s+no\s+(.+?)(?:\s+da\s+Faculdade|\s+na\s+Sumar[eé]|\s+da\s+Sumar[eé]|,|\.|\?|$)/is,
    /aproveitar\s+(?:as\s+)?disciplinas\s+(?:da|de)\s+(.+?)\s+.*ingressar\s+no\s+(.+?)(?:\s+da\s+Faculdade|\s+na\s+Sumar[eé]|\s+da\s+Sumar[eé]|,|\.|\?|$)/is,
  ]
  for (const rx of patterns) {
    const m = t.match(rx)
    if (m?.[1] && m?.[2]) {
      return { origem: cleanCursoLabel(m[1]), destino: cleanCursoLabel(m[2]) }
    }
  }
  return null
}

export function extractTransferenciaDestinoFromAssistant(text) {
  const t = String(text || '')
  const patterns = [
    /orientar\s+melhor\s+para\s+o\s+(.+?)(?:\s+na\s+Sumar[eé]|,|\.|\?|$)/i,
    /ingressar\s+no\s+(.+?)(?:\s+da\s+Faculdade|\s+na\s+Sumar[eé]|\s+da\s+Sumar[eé]|,|\.|\?|$)/i,
    /curso\s+de\s+(?:gradua[cç][aã]o\s+em\s+)?(.+?)\s+na\s+Sumar[eé]/i,
  ]
  for (const rx of patterns) {
    const m = t.match(rx)
    if (m?.[1]) return cleanCursoLabel(m[1])
  }
  return null
}

export function extractTransferenciaFromHistory(historyMessages = []) {
  const users = [...historyMessages].reverse().filter((m) => normalizeRole(m?.role) === 'user')
  for (const m of users) {
    const parsed = parseTransferenciaIntentFromText(m.content)
    if (parsed?.origem && parsed?.destino) return parsed
  }
  return null
}

/**
 * Monta origem, destino e semestre a partir de mensagens separadas no histórico
 * (lead informa origem+semestre; assistente confirma destino; lead confirma com "sim").
 */
export function extractTransferenciaContext(historyMessages = []) {
  let origem = null
  let destino = null
  let semestre = null

  for (const m of [...historyMessages].reverse()) {
    if (normalizeRole(m?.role) !== 'assistant') continue
    const conf = extractTransferenciaConfirmacaoFromAssistant(m.content)
    if (conf?.origem && conf?.destino) {
      origem = conf.origem
      destino = conf.destino
      break
    }
  }

  if (!destino) {
    for (const m of [...historyMessages].reverse()) {
      if (normalizeRole(m?.role) !== 'assistant') continue
      const d = extractTransferenciaDestinoFromAssistant(m.content)
      if (d) {
        destino = d
        break
      }
    }
  }

  for (const m of [...historyMessages].reverse()) {
    if (normalizeRole(m?.role) !== 'user') continue
    const parsed = parseTransferenciaIntentFromText(m.content)
    if (parsed?.origem && !origem) origem = parsed.origem
    if (parsed?.destino && !destino) destino = parsed.destino
    const os = extractOrigemSemestreFromUserText(m.content)
    if (os?.origem && !origem) origem = os.origem
    if (os?.semestre && !semestre) semestre = os.semestre
    const sem = parseSemestreFromUserMessage(m.content)
    if (sem && !semestre) semestre = sem
  }

  if (!origem || !destino) return null
  return { origem, destino, semestre }
}

async function runTransferenciaComplete(env, ctx, payload, stepType) {
  const { telefone, leadId, pushName, executionId, model, historyMessages, t0 } = ctx
  const flowCtx = { telefone, leadId, pushName, executionId, model, historyMessages, t0 }
  const result = await runRegistrarTransferencia(env, payload, flowCtx)
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
      steps: [{ type: stepType, ok: Boolean(result.ok), code: result.code }, ...(result.steps || [])],
      toolCalls: [{ tool: 'registrar_transferencia', ok: Boolean(result.ok), code: result.code }],
      ctxSnapshot: {
        ...(result.ctxSnapshot || {}),
        replySource: stepType,
        transferenciaAutoComplete: true,
      },
    }),
  }
}

/**
 * Lead respondeu dados de transferência após o agente pedir origem/semestre.
 */
export async function tryHandleTransferenciaDadosPendentes(env, ctx = {}) {
  const { telefone, userMessage, historyMessages = [], executionId } = ctx
  if (!telefone || !userMessage) return null

  const lastAssist = lastAssistantText(historyMessages)
  if (!assistantAskedTransferenciaDadosPendentes(lastAssist)) return null

  const context = extractTransferenciaContext([
    ...historyMessages,
    { role: 'user', content: userMessage },
  ])
  if (!context?.origem || !context?.destino || !context?.semestre) return null

  console.log(
    `[${executionId}] TRANSFERENCIA_AUTO_COMPLETE origem="${context.origem}" destino="${context.destino}" semestre=${context.semestre}`,
  )

  return runTransferenciaComplete(
    env,
    ctx,
    {
      telefone,
      curso_origem: context.origem,
      semestre_concluido: context.semestre,
      curso_desejado: context.destino,
    },
    'transferencia_auto_complete',
  )
}

/**
 * Lead confirmou com "sim" após o agente resumir origem → destino da transferência.
 */
export async function tryHandleTransferenciaConfirmacao(env, ctx = {}) {
  const { telefone, userMessage, historyMessages = [], executionId } = ctx
  if (!telefone || !userMessage) return null

  const lastAssist = lastAssistantText(historyMessages)
  if (!assistantAskedTransferenciaConfirmacao(lastAssist)) return null
  if (!messageConfirmsTransferencia(userMessage)) return null

  const context = extractTransferenciaContext(historyMessages)
  if (!context?.origem || !context?.destino || !context?.semestre) return null

  console.log(
    `[${executionId}] TRANSFERENCIA_CONFIRMADA origem="${context.origem}" destino="${context.destino}" semestre=${context.semestre}`,
  )

  return runTransferenciaComplete(
    env,
    ctx,
    {
      telefone,
      curso_origem: context.origem,
      semestre_concluido: context.semestre,
      curso_desejado: context.destino,
    },
    'transferencia_confirmada',
  )
}

/**
 * Lead repetiu o curso desejado após o agente perguntar curso indevidamente.
 */
export async function tryHandleTransferenciaCursoRestate(env, ctx = {}) {
  const { telefone, userMessage, historyMessages = [], executionId } = ctx
  if (!telefone || !userMessage) return null
  if (!conversationMentionsTransferencia(historyMessages)) return null

  const destinoMsg =
    extractCursoAreaFromText(userMessage) ||
    cleanCursoLabel(
      String(userMessage || '')
        .replace(/^(bacharelado|licenciatura|tecn[oó]logo)\s+(em\s+)?/i, '')
        .trim(),
    )
  if (!destinoMsg || destinoMsg.length < 4) return null

  const context = extractTransferenciaContext(historyMessages)
  if (!context?.origem || !context?.semestre) return null

  const destino = context.destino || destinoMsg
  console.log(
    `[${executionId}] TRANSFERENCIA_CURSO_RESTATE origem="${context.origem}" destino="${destino}" semestre=${context.semestre}`,
  )

  return runTransferenciaComplete(
    env,
    ctx,
    {
      telefone,
      curso_origem: context.origem,
      semestre_concluido: context.semestre,
      curso_desejado: destino,
    },
    'transferencia_curso_restate',
  )
}
