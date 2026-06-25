/**
 * Saída do canal — substitui a ativação do salesbot 49777 no pedido de humano.
 *
 * Passo 1: lead pede humano (ou agente não resolve) → pergunta canônica de
 *          confirmação + status aguardando_confirm_saida_canal.
 * Passo 2: lead confirma → envia links oficiais (atendimento + ouvidoria),
 *          move o lead para a fila 143 do pipeline 13756724, pausa a IA.
 *          Lead recusa → limpa o estado e devolve ao fluxo normal (LLM).
 */

import {
  HANDOFF_STATUS_AGUARDANDO_CONFIRM_SAIDA,
  HANDOFF_STATUS_LINKS_ENVIADOS,
  buildConfirmExitChannelReply,
  buildExitChannelLinksReply,
  buildExitChannelAlreadyDoneReply,
  assistantAskedExitChannelConfirm,
  messageConfirmsChannelExit,
  messageDeclinesChannelExit,
  SUMARE_ATENDIMENTO_URL,
  SUMARE_OUVIDORIA_URL,
} from '../libShared/humanHandoffHeuristics.js'
import {
  buildAcademicAffairsRedirectReply,
  historyHasAcademicAffairsTopic,
} from '../libShared/academicAffairsHeuristics.js'
import { lastAssistantText } from '../libShared/conversationContextHeuristics.js'
import { filterHistoryMessagesForAgent } from '../libShared/historySanitize.js'
import {
  fetchDadosClienteByTelefone,
  updateDadosCliente,
  ensureDadosClienteRow,
  getLeadIdByTelefone,
} from './dadosClienteStore.js'
import { createLeadAuditNote, updateLeadPipelineStatus } from './kommoClient.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'
const HANDOFF_PIPELINE_DEFAULT = 13756724
const HANDOFF_STATUS_DEFAULT = 143

export function resolveChannelExitTarget(env = process.env) {
  const pipelineId = Number(env?.KOMMO_SAIDA_CANAL_PIPELINE_ID) || HANDOFF_PIPELINE_DEFAULT
  const statusId = Number(env?.KOMMO_SAIDA_CANAL_STATUS_ID) || HANDOFF_STATUS_DEFAULT
  return { pipelineId, statusId }
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
    humanHandoffHandled: true,
  }
}

async function resolveLeadId(env, telefone, leadIdHint) {
  if (Number.isFinite(leadIdHint) && leadIdHint > 0) return leadIdHint
  const fromDb = await getLeadIdByTelefone(env, telefone)
  if (fromDb != null) return Number(fromDb) || fromDb
  return null
}

async function setStatus(env, telefone, status, leadIdHint) {
  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadIdHint,
    fields: { [FORM_STATUS_FIELD]: status },
  }).catch(() => {})
  return updateDadosCliente(env, { telefone, fields: { [FORM_STATUS_FIELD]: status } })
}

/**
 * Passo 1 — grava o estado e devolve a pergunta canônica. Usado tanto pelo
 * auto-handoff pré-LLM quanto pelo executor da tool distribuir_humano.
 */
export async function startChannelExitConfirm(env, { telefone, leadId, executionId, model, pushName, t0 }) {
  const idLead = await resolveLeadId(env, telefone, leadId)
  await setStatus(env, telefone, HANDOFF_STATUS_AGUARDANDO_CONFIRM_SAIDA, idLead).catch(() => {})
  console.log(
    `[saidaCanal] lead=${idLead ?? 'n/a'} telefone=${telefone} pergunta_confirm_saida_canal enviada`,
  )
  return buildAgentReturn({
    executionId,
    model,
    t0: t0 ?? Date.now(),
    reply: buildConfirmExitChannelReply({ pushName }),
    steps: [{ type: 'saida_canal_confirm_oferecida' }],
    ctxSnapshot: { saidaCanal: HANDOFF_STATUS_AGUARDANDO_CONFIRM_SAIDA },
  })
}

/** Passo 2 — links + mover fila + pausar IA. */
async function finalizeChannelExit(env, { telefone, idLead, executionId, pushName, t0, model, historyMessages }) {
  const academicContext = historyHasAcademicAffairsTopic(historyMessages)
  const reply = academicContext
    ? buildAcademicAffairsRedirectReply({ pushName })
    : buildExitChannelLinksReply({ pushName })
  const steps = [{ type: academicContext ? 'saida_canal_academic_redirect' : 'saida_canal_links_enviados' }]
  const toolCalls = []
  const { pipelineId, statusId } = resolveChannelExitTarget(env)

  await setStatus(env, telefone, HANDOFF_STATUS_LINKS_ENVIADOS, idLead)
  await updateDadosCliente(env, { telefone, fields: { atendimento_ia: 'pause' } }).catch(() => {})

  if (idLead) {
    await createLeadAuditNote(
      env,
      idLead,
      (academicContext
        ? 'Lead confirmou saída do canal após assunto acadêmico (ex.: diploma). Resposta canônica aluno/ex-aluno enviada. '
        : 'Lead confirmou que não deseja seguir o atendimento pelo canal. ') +
        `Links oficiais enviados (atendimento: ${SUMARE_ATENDIMENTO_URL} | ouvidoria: ${SUMARE_OUVIDORIA_URL}). ` +
        `Movido para fila ${statusId} (pipeline ${pipelineId}).`,
    ).catch(() => {})

    const move = await updateLeadPipelineStatus(env, idLead, { pipelineId, statusId }).catch(
      (err) => ({ ok: false, error: err?.message }),
    )
    steps.push({
      type: 'move_lead_saida_canal',
      ok: Boolean(move?.ok),
      pipeline_id: pipelineId,
      status_id: statusId,
      error: move?.ok ? undefined : move?.error || move?.code,
    })
    toolCalls.push({
      tool: 'move_lead_saida_canal',
      args: { id_lead: idLead, pipeline_id: pipelineId, status_id: statusId },
      result: move?.ok
        ? `Lead movido para pipeline=${pipelineId} status=${statusId}`
        : `Falha: ${move?.error || move?.code || 'unknown'}`,
      ok: Boolean(move?.ok),
    })
    console.log(
      `[saidaCanal] lead=${idLead} telefone=${telefone} links_enviados move_ok=${Boolean(move?.ok)} status=${statusId}`,
    )
  }

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps,
      toolCalls,
      ctxSnapshot: {
        saidaCanal: HANDOFF_STATUS_LINKS_ENVIADOS,
        saidaCanalConcluida: true,
        iaPaused: true,
      },
    }),
  }
}

/**
 * Handler "early" — roda ANTES do gate `atendimento_ia=pause`. Se o lead já
 * foi encaminhado (links enviados) e voltar a falar, reapresenta os links em
 * vez de ficar em silêncio.
 */
export async function tryHandleSaidaCanalJaEncerrada(env, input) {
  const { telefone, userMessage, executionId, model, pushName, t0 } = input || {}
  if (!telefone || !String(userMessage || '').trim()) return null

  const row = await fetchDadosClienteByTelefone(env, telefone, FORM_STATUS_FIELD).catch(() => null)
  if (row?.[FORM_STATUS_FIELD] !== HANDOFF_STATUS_LINKS_ENVIADOS) return null

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply: buildExitChannelAlreadyDoneReply({ pushName }),
      steps: [{ type: 'saida_canal_ja_encerrada' }],
      ctxSnapshot: { saidaCanal: HANDOFF_STATUS_LINKS_ENVIADOS },
    }),
  }
}

/**
 * Processa a RESPOSTA do lead à pergunta de confirmação (passo 1 → passo 2).
 * Retorna null quando não está no passo de confirmação ou quando o lead quer
 * continuar (estado limpo; o LLM segue o atendimento normalmente).
 */
export async function tryHandleChannelExitConfirmStep(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0 } = input || {}
  if (!telefone || !String(userMessage || '').trim()) return null

  const historyMessages = filterHistoryMessagesForAgent(input.historyMessages || [])
  const row = await fetchDadosClienteByTelefone(env, telefone, FORM_STATUS_FIELD).catch(() => null)
  const status = row?.[FORM_STATUS_FIELD] ?? null

  const inConfirmStep =
    status === HANDOFF_STATUS_AGUARDANDO_CONFIRM_SAIDA ||
    assistantAskedExitChannelConfirm(lastAssistantText(historyMessages))
  if (!inConfirmStep) return null

  const idLead = await resolveLeadId(env, telefone, leadIdHint)

  if (messageDeclinesChannelExit(userMessage)) {
    console.log(`[saidaCanal] telefone=${telefone} lead quer continuar no canal — estado limpo`)
    if (status === HANDOFF_STATUS_AGUARDANDO_CONFIRM_SAIDA) {
      await setStatus(env, telefone, null, idLead).catch(() => {})
    }
    return null
  }

  if (messageConfirmsChannelExit(userMessage)) {
    return finalizeChannelExit(env, {
      telefone,
      idLead,
      executionId,
      pushName,
      t0,
      model,
      historyMessages,
    })
  }

  // Mensagem que não confirma nem recusa (nova pergunta, saudação etc.):
  // limpa o estado e devolve ao fluxo normal — sem loop de re-pergunta.
  console.log(
    `[saidaCanal] telefone=${telefone} confirm_step_saida msg_neutra="${String(userMessage || '')
      .slice(0, 80)
      .replace(/\n/g, ' ')}" — limpando estado`,
  )
  if (status === HANDOFF_STATUS_AGUARDANDO_CONFIRM_SAIDA) {
    await setStatus(env, telefone, null, idLead).catch(() => {})
  }
  return null
}
