/**
 * Movimentação de leads no funil Kommo conforme etapa da inscrição.
 *
 * Regra de negócio (Agente Sumaré):
 *   - Atendimento (106140284) → captação comercial
 *   - Inscrição → formulário enviado / captação
 *   - Aguardando pagamento → link de pagamento da matrícula já encaminhado
 */

import { getLeadById, updateLeadPipelineStatus } from './kommoClient.js'
import {
  AGENT_FUNNEL_PIPELINE_ID,
  AGENT_FUNNEL_STATUS_INSCRICAO,
  AGENT_FUNNEL_STATUS_AGUARDANDO_PAGAMENTO,
} from './kommoAgentFunnelGate.js'
import {
  createDealNote,
  getDealById,
  isEduitCuid,
  resolveEduitStages,
  updateDealStage,
} from './eduitClient.js'
import { resolvePosMatriculaTarget } from './inscricaoAceitePagamentoFlow.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'
import { rowHasPagamentoLinkEnviado } from '../libShared/matriculaPagamentoLink.js'

function resolveInscricaoTarget(env = process.env) {
  const pipelineId = Number(env.AGENT_FUNNEL_PIPELINE_ID) || AGENT_FUNNEL_PIPELINE_ID
  const statusId = Number(env.AGENT_FUNNEL_STATUS_INSCRICAO) || AGENT_FUNNEL_STATUS_INSCRICAO
  return { pipelineId, statusId }
}

/** Status internos que indicam lead na jornada de inscrição (coluna Inscrição). */
export function inscricaoFormStatusRequiresInscricaoFunnel(status) {
  const s = String(status || '').trim()
  if (!s) return false
  return [
    INSCRICAO_FORM_STATUS_AGUARDANDO,
    INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
    INSCRICAO_FORM_STATUS_CONCLUIDO,
    INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  ].includes(s)
}

/** Dados Supabase indicam captação / link de contrato ativo. */
export function dadosClienteRequiresInscricaoFunnel(row) {
  if (!row || typeof row !== 'object') return false
  if (rowHasPagamentoLinkEnviado(row)) return false
  if (row.captacao_candidato_id || row.captacao_contrato_link) return true
  return inscricaoFormStatusRequiresInscricaoFunnel(row.inscricao_form_status)
}

function leadAlreadyInTargetFunnel(lead, pipelineId, statusId) {
  if (!lead) return false
  return Number(lead.pipeline_id) === pipelineId && Number(lead.status_id) === statusId
}

function leadInPosMatriculaFunnel(lead, env) {
  const { pipelineId, statusId } = resolvePosMatriculaTarget(env)
  return (
    Number(lead?.pipeline_id) === pipelineId && Number(lead?.status_id) === statusId
  )
}

/**
 * Move o lead para a coluna Inscrição se ainda estiver em Atendimento (ou outra etapa).
 * Idempotente — não move se já estiver em Inscrição ou Aguardando pagamento.
 */
export async function moveLeadToInscricaoIfNeeded(env, leadId, { reason = 'inscricao_stage' } = {}) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, skipped: true, reason: 'invalid_lead_id' }
  }

  const { pipelineId, statusId } = resolveInscricaoTarget(env)
  const got = await getLeadById(env, id)
  const lead = got.ok ? got.lead : null

  if (leadAlreadyInTargetFunnel(lead, pipelineId, statusId)) {
    return { ok: true, skipped: true, reason: 'already_in_inscricao', pipelineId, statusId }
  }
  if (leadInPosMatriculaFunnel(lead, env)) {
    return { ok: true, skipped: true, reason: 'already_in_pos_matricula' }
  }

  const move = await updateLeadPipelineStatus(env, id, { pipelineId, statusId })
  if (!move.ok) {
    console.warn(
      `[funnel-move] lead=${id} move→inscrição falhou reason=${reason} err=${move.error || move.code}`,
    )
    return { ok: false, skipped: false, reason, error: move.error || move.code, pipelineId, statusId }
  }

  console.log(
    `[funnel-move] lead=${id} movido p/ inscrição (${pipelineId}/${statusId}) reason=${reason}`,
  )
  return { ok: true, moved: true, reason, pipelineId, statusId }
}

/** Decide se o lead precisa ir para Inscrição com base no estado interno. */
export function shouldMoveLeadToInscricao({ inscricaoFormStatus, dadosRow } = {}) {
  if (String(inscricaoFormStatus || '') === INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO) {
    return false
  }
  if (inscricaoFormStatusRequiresInscricaoFunnel(inscricaoFormStatus)) return true
  return dadosClienteRequiresInscricaoFunnel(dadosRow)
}

function useEduitMove(env, leadId) {
  return String(env?.CRM_BACKEND || '').toLowerCase() === 'eduit' || isEduitCuid(leadId)
}

/**
 * Move o card para Aguardando pagamento quando o link da matrícula foi enviado.
 * Idempotente. Não regride ganho/perdido/fechamento.
 */
export async function moveLeadToAguardandoPagamentoIfNeeded(
  env,
  leadId,
  { reason = 'pagamento_link_enviado', note = true } = {},
) {
  const id = String(leadId || '').trim()
  if (!id) return { ok: false, skipped: true, reason: 'invalid_lead_id' }

  if (useEduitMove(env, id)) {
    if (!isEduitCuid(id)) return { ok: false, skipped: true, reason: 'invalid_lead_id' }
    const stages = resolveEduitStages(env)
    const target = stages.aguardandoPagamento
    const got = await getDealById(env, id)
    const current = String(got.deal?.stageId || got.deal?.stage_id || '').trim()
    if (current === target) {
      return { ok: true, skipped: true, reason: 'already_in_aguardando_pagamento', stageId: target }
    }
    const terminal = [stages.ganho, stages.perdido, stages.fechamento]
    if (terminal.includes(current)) {
      return { ok: true, skipped: true, reason: 'terminal_stage', stageId: current }
    }
    const move = await updateDealStage(env, id, target)
    if (!move.ok) {
      console.warn(
        `[funnel-move] lead=${id} move→aguardando_pagamento falhou reason=${reason} err=${move.error || move.code}`,
      )
      return { ok: false, skipped: false, reason, error: move.error || move.code, stageId: target }
    }
    if (note) {
      await createDealNote(
        env,
        id,
        `Link de pagamento da matrícula encaminhado — card movido para Aguardando pagamento (${reason}).`,
      ).catch(() => {})
    }
    console.log(`[funnel-move] lead=${id} movido p/ aguardando_pagamento reason=${reason}`)
    return { ok: true, moved: true, reason, stageId: target }
  }

  const num = Number(id)
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, skipped: true, reason: 'invalid_lead_id' }
  }
  const pipelineId = Number(env.AGENT_FUNNEL_PIPELINE_ID) || AGENT_FUNNEL_PIPELINE_ID
  const statusId = Number(env.AGENT_FUNNEL_STATUS_AGUARDANDO_PAGAMENTO) || AGENT_FUNNEL_STATUS_AGUARDANDO_PAGAMENTO
  const got = await getLeadById(env, num)
  const lead = got.ok ? got.lead : null
  if (leadAlreadyInTargetFunnel(lead, pipelineId, statusId)) {
    return { ok: true, skipped: true, reason: 'already_in_aguardando_pagamento', pipelineId, statusId }
  }
  if (leadInPosMatriculaFunnel(lead, env)) {
    return { ok: true, skipped: true, reason: 'already_in_pos_matricula' }
  }
  const move = await updateLeadPipelineStatus(env, num, { pipelineId, statusId })
  if (!move.ok) {
    console.warn(
      `[funnel-move] lead=${num} move→aguardando_pagamento falhou reason=${reason} err=${move.error || move.code}`,
    )
    return { ok: false, skipped: false, reason, error: move.error || move.code, pipelineId, statusId }
  }
  console.log(
    `[funnel-move] lead=${num} movido p/ aguardando_pagamento (${pipelineId}/${statusId}) reason=${reason}`,
  )
  return { ok: true, moved: true, reason, pipelineId, statusId }
}
