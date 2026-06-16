/**
 * Movimentação de leads no funil Kommo conforme etapa da inscrição.
 *
 * Regra de negócio (Agente Sumaré):
 *   - Atendimento (106140284) → captação comercial
 *   - Inscrição (106804680) → formulário enviado / captação / aguardando pagamento do contrato
 *   - Aguardando pagamento (106426128) → comprovante recebido (pós-matrícula)
 */

import { getLeadById, updateLeadPipelineStatus } from './kommoClient.js'
import {
  AGENT_FUNNEL_PIPELINE_ID,
  AGENT_FUNNEL_STATUS_INSCRICAO,
} from './kommoAgentFunnelGate.js'
import { resolvePosMatriculaTarget } from './inscricaoAceitePagamentoFlow.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'

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
    INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
    INSCRICAO_FORM_STATUS_CONCLUIDO,
    INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  ].includes(s)
}

/** Dados Supabase indicam captação / link de contrato ativo. */
export function dadosClienteRequiresInscricaoFunnel(row) {
  if (!row || typeof row !== 'object') return false
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
