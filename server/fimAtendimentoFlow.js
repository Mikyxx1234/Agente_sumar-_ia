/**
 * Fim de atendimento solicitado pelo lead (encerramento educado ou explícito).
 * → sum_Motivo da perda = "Sem Interesse" → fila 143 → pausa IA.
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO,
  INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA,
} from '../libShared/inscricaoFormHeuristics.js'
import { messageExpressesEndOfServiceRequest } from '../libShared/fimAtendimentoHeuristics.js'
import { buildDesistenciaAgradecimentoReply } from '../libShared/inscricaoDesistenciaHeuristics.js'
import { filterHistoryMessagesForAgent } from '../libShared/historySanitize.js'
import {
  fetchDadosClienteByTelefone,
  updateDadosCliente,
  ensureDadosClienteRow,
  getLeadIdByTelefone,
} from './dadosClienteStore.js'
import { DADOS_CLIENTE_FORM_GUARD_SELECT } from './dadosClienteInscricaoFields.js'
import { createLeadAuditNote, updateLeadPipelineStatus } from './kommoClient.js'
import { setSumMotivoPerdaSemInteresse } from './sumareLeadFields.js'
import { resolveDesistenciaTarget } from './inscricaoDesistenciaFlow.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

const BLOCK_STATUSES = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO,
  INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA,
])

function isFeatureEnabled(env = process.env) {
  const raw = String(env?.FIM_ATENDIMENTO_ENABLED ?? env?.INSCRICAO_DESISTENCIA_ENABLED ?? 'true')
    .trim()
    .toLowerCase()
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

async function finalizeFimAtendimento(env, { telefone, idLead, executionId, pushName, t0, model }) {
  const reply = buildDesistenciaAgradecimentoReply({ pushName })
  const steps = [{ type: 'fim_atendimento_agradecimento' }]
  const toolCalls = []
  const { pipelineId, statusId } = resolveDesistenciaTarget(env)

  await setStatus(env, telefone, INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA, idLead)
  await updateDadosCliente(env, { telefone, fields: { atendimento_ia: 'pause' } }).catch(() => {})

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

    await createLeadAuditNote(
      env,
      idLead,
      'Lead solicitou encerramento do atendimento via WhatsApp. Motivo da perda: Sem Interesse. ' +
        `Movido para fila ${statusId} (pipeline ${pipelineId}).`,
    ).catch(() => {})

    const move = await updateLeadPipelineStatus(env, idLead, { pipelineId, statusId }).catch(
      (err) => ({ ok: false, error: err?.message }),
    )
    steps.push({
      type: 'move_lead_fim_atendimento',
      ok: Boolean(move?.ok),
      pipeline_id: pipelineId,
      status_id: statusId,
      error: move?.ok ? undefined : move?.error || move?.code,
    })
    toolCalls.push({
      tool: 'move_lead_fim_atendimento',
      args: { id_lead: idLead, pipeline_id: pipelineId, status_id: statusId },
      result: move?.ok
        ? `Lead movido para pipeline=${pipelineId} status=${statusId}`
        : `Falha: ${move?.error || move?.code || 'unknown'}`,
      ok: Boolean(move?.ok),
    })

    console.log(
      `[fimAtendimento] lead=${idLead} telefone=${telefone} motivo_ok=${Boolean(motivo?.ok)} move_ok=${Boolean(move?.ok)} status=${statusId}`,
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
        fimAtendimentoConcluido: true,
        iaPaused: true,
        posDesistenciaStatusId: statusId,
      },
    }),
  }
}

/**
 * @returns {Promise<null | { handled: true, result: object }>}
 */
export async function tryHandleFimAtendimentoFlow(env, input) {
  if (!isFeatureEnabled(env)) return null

  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  if (!telefone || !String(userMessage || '').trim()) return null

  const historyMessages = filterHistoryMessagesForAgent(input.historyMessages || [])
  const row = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_FORM_GUARD_SELECT).catch(
    () => null,
  )
  const status = row?.[FORM_STATUS_FIELD] ?? null

  if (status === INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA) {
    return null
  }

  if (BLOCK_STATUSES.has(status)) return null

  if (!messageExpressesEndOfServiceRequest(userMessage, historyMessages)) return null

  const idLead = await resolveLeadId(env, telefone, leadIdHint)
  console.log(
    `[fimAtendimento] lead=${idLead ?? 'n/a'} telefone=${telefone} encerramento msg="${String(userMessage || '')
      .slice(0, 80)
      .replace(/\n/g, ' ')}"`,
  )

  return finalizeFimAtendimento(env, { telefone, idLead, executionId, pushName, t0, model })
}
