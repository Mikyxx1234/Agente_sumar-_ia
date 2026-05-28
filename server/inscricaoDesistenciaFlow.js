/**
 * Fluxo de desistência de inscrição: após o agente apresentar o curso e
 * tirar dúvidas, se o lead não quiser seguir → confirma desistência →
 * agradece → grava sum_Motivo da perda = "Sem Interesse" → move fila 143.
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA,
  INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  shouldOfferDesistenciaConfirm,
  assistantAskedDesistenciaConfirm,
  messageConfirmsFinalDesistencia,
  messageRevokesDesistencia,
  buildConfirmDesistenciaReply,
  buildDesistenciaAgradecimentoReply,
} from '../libShared/inscricaoDesistenciaHeuristics.js'
import { lastAssistantText } from '../libShared/conversationContextHeuristics.js'
import { filterHistoryMessagesForAgent } from '../libShared/historySanitize.js'
import {
  fetchDadosClienteByTelefone,
  updateDadosCliente,
  ensureDadosClienteRow,
  getLeadIdByTelefone,
} from './dadosClienteStore.js'
import { DADOS_CLIENTE_INSCRICAO_SELECT } from './dadosClienteInscricaoFields.js'
import { createLeadNote, updateLeadPipelineStatus } from './kommoClient.js'
import { setSumMotivoPerdaSemInteresse } from './sumareLeadFields.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

const DESISTENCIA_PIPELINE_DEFAULT = 13756724
const DESISTENCIA_STATUS_DEFAULT = 143

/** Status em que a matrícula está em andamento — não oferecer desistência. */
const BLOCK_DESISTENCIA_STATUSES = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO,
  INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
])

export function resolveDesistenciaTarget(env = process.env) {
  const pipelineId =
    Number(env?.KOMMO_DESISTENCIA_PIPELINE_ID) || DESISTENCIA_PIPELINE_DEFAULT
  const statusId = Number(env?.KOMMO_DESISTENCIA_STATUS_ID) || DESISTENCIA_STATUS_DEFAULT
  return { pipelineId, statusId }
}

function isFeatureEnabled(env = process.env) {
  const raw = String(env?.INSCRICAO_DESISTENCIA_ENABLED ?? 'true').trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes'
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

async function finalizeDesistencia(env, { telefone, idLead, executionId, pushName, t0, model }) {
  const reply = buildDesistenciaAgradecimentoReply({ pushName })
  const steps = [{ type: 'desistencia_agradecimento' }]
  const toolCalls = []
  const { pipelineId, statusId } = resolveDesistenciaTarget(env)

  await setStatus(env, telefone, INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA, idLead)
  await updateDadosCliente(env, {
    telefone,
    fields: { atendimento_ia: 'pause' },
  }).catch(() => {})

  if (idLead) {
    const motivo = await setSumMotivoPerdaSemInteresse(env, { leadId: idLead, telefone }).catch(
      (err) => ({ ok: false, error: err?.message }),
    )
    steps.push({
      type: 'kommo_motivo_perda',
      ok: Boolean(motivo?.ok),
      motivo: motivo?.motivo || 'Sem Interesse',
      error: motivo?.ok ? undefined : motivo?.code || motivo?.error,
    })
    toolCalls.push({
      tool: 'set_sum_motivo_perda',
      args: { id_lead: idLead, valor: 'Sem Interesse' },
      result: motivo?.ok ? 'Motivo da perda gravado' : motivo?.error || motivo?.code || 'falha',
      ok: Boolean(motivo?.ok),
    })

    await createLeadNote(
      env,
      idLead,
      'Lead confirmou desistência da inscrição via WhatsApp. Motivo da perda: Sem Interesse. ' +
        `Movido para fila ${statusId} (pipeline ${pipelineId}).`,
    ).catch(() => {})

    const move = await updateLeadPipelineStatus(env, idLead, { pipelineId, statusId }).catch(
      (err) => ({ ok: false, error: err?.message }),
    )
    steps.push({
      type: 'move_lead_desistencia',
      ok: Boolean(move?.ok),
      pipeline_id: pipelineId,
      status_id: statusId,
      error: move?.ok ? undefined : move?.error || move?.code,
    })
    toolCalls.push({
      tool: 'move_lead_desistencia',
      args: { id_lead: idLead, pipeline_id: pipelineId, status_id: statusId },
      result: move?.ok
        ? `Lead movido para pipeline=${pipelineId} status=${statusId}`
        : `Falha: ${move?.error || move?.code || 'unknown'}`,
      ok: Boolean(move?.ok),
    })

    console.log(
      `[inscricaoDesistencia] lead=${idLead} telefone=${telefone} ` +
        `motivo_ok=${Boolean(motivo?.ok)} move_ok=${Boolean(move?.ok)} status=${statusId}`,
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
        inscricaoForm: INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
        desistenciaConcluida: true,
        iaPaused: true,
        posDesistenciaStatusId: resolveDesistenciaTarget(env).statusId,
      },
    }),
  }
}

/**
 * @returns {Promise<null | { handled: true, result: object }>}
 */
export async function tryHandleInscricaoDesistenciaFlow(env, input) {
  if (!isFeatureEnabled(env)) return null

  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  if (!telefone || !String(userMessage || '').trim()) return null

  const historyMessages = filterHistoryMessagesForAgent(input.historyMessages || [])
  const row = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_INSCRICAO_SELECT).catch(
    () => null,
  )
  const status = row?.[FORM_STATUS_FIELD] ?? null

  if (status === INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA) {
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply:
          'Obrigado pelo contato! Sua desistência já foi registrada. ' +
          'Se tiver qualquer dúvida no futuro, estamos à disposição por aqui.',
        steps: [{ type: 'desistencia_ja_registrada' }],
        ctxSnapshot: { inscricaoForm: status },
      }),
    }
  }

  if (BLOCK_DESISTENCIA_STATUSES.has(status) && status !== INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA) {
    return null
  }

  const idLead = await resolveLeadId(env, telefone, leadIdHint)
  const inConfirmStep =
    status === INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA ||
    assistantAskedDesistenciaConfirm(lastAssistantText(historyMessages))

  if (inConfirmStep) {
    if (messageRevokesDesistencia(userMessage)) {
      await setStatus(env, telefone, null, idLead)
      return null
    }
    if (messageConfirmsFinalDesistencia(userMessage)) {
      return finalizeDesistencia(env, {
        telefone,
        idLead,
        executionId,
        pushName,
        t0,
        model,
      })
    }
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: buildConfirmDesistenciaReply({ pushName }),
        steps: [{ type: 'desistencia_confirm_repetida' }],
        ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA },
      }),
    }
  }

  if (!shouldOfferDesistenciaConfirm(userMessage, historyMessages)) return null

  await setStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA, idLead)

  console.log(
    `[inscricaoDesistencia] lead=${idLead ?? 'n/a'} telefone=${telefone} oferta_confirm_desistencia`,
  )

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply: buildConfirmDesistenciaReply({ pushName }),
      steps: [{ type: 'desistencia_confirm_oferecida' }],
      ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA },
    }),
  }
}
