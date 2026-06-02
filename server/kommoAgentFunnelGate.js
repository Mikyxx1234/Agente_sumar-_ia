/**
 * Trinco fixo do funil da IA — Faculdade Sumaré.
 *
 * O agente automático (scheduler + flush WhatsApp) só pode atender leads em:
 *   pipeline_id = 13756724 (Agente-Sumaré)
 *   status_id   ∈ { 106140284 (Atendimento), 106804680 (inscrição) }
 *
 * Em "inscrição" a IA segue conversando para encaminhar os dados até o
 * candidato mandar o comprovante de pagamento — quando o comprovante chega, o
 * lead é movido para "aguardando pagamento" (106426128) e a IA pausa. Portanto
 * "aguardando pagamento" NÃO entra no funil atendido (de propósito).
 *
 * Valores de KOMMO_AGENT_* no .env que divergirem são ignorados (com warn no boot).
 */

import { findLeadByPhone, getLeadById } from './kommoClient.js'

/** @type {const} */
export const AGENT_FUNNEL_PIPELINE_ID = 13756724

/** Etapa "Atendimento" (primária). @type {const} */
export const AGENT_FUNNEL_STATUS_ID = 106140284

/** Etapa "inscrição" — IA continua atendendo até o comprovante. @type {const} */
export const AGENT_FUNNEL_STATUS_INSCRICAO = 106804680

/** Todas as etapas atendidas pela IA (NÃO inclui "aguardando pagamento"). */
export const AGENT_FUNNEL_STATUS_IDS = [
  AGENT_FUNNEL_STATUS_ID,
  AGENT_FUNNEL_STATUS_INSCRICAO,
]

let warnedEnvMismatch = false

function warnEnvMismatchOnce(env) {
  if (warnedEnvMismatch) return
  const envPipe = Number(env.KOMMO_AGENT_PIPELINE_ID)
  const envStatus = Number(env.KOMMO_AGENT_STATUS_ID)
  const envCsv = String(env.KOMMO_AGENT_STATUS_IDS || '').trim()
  const mismatch =
    (Number.isFinite(envPipe) && envPipe > 0 && envPipe !== AGENT_FUNNEL_PIPELINE_ID) ||
    (Number.isFinite(envStatus) && envStatus > 0 && !AGENT_FUNNEL_STATUS_IDS.includes(envStatus)) ||
    Boolean(envCsv)
  if (!mismatch) return
  warnedEnvMismatch = true
  console.warn(
    '[funnel-gate] KOMMO_AGENT_PIPELINE_ID / KOMMO_AGENT_STATUS_ID(S) no .env divergem do funil fixo — ' +
      `usando pipeline=${AGENT_FUNNEL_PIPELINE_ID} status=[${AGENT_FUNNEL_STATUS_IDS.join(',')}] apenas.`,
  )
}

/**
 * IDs efetivos do funil (sempre os fixos acima).
 * @returns {{ pipelineId: number, statusIds: number[] }}
 */
export function resolveAgentFunnelFromEnv(env) {
  warnEnvMismatchOnce(env)
  return {
    pipelineId: AGENT_FUNNEL_PIPELINE_ID,
    statusIds: [...AGENT_FUNNEL_STATUS_IDS],
  }
}

/**
 * @param {object | null | undefined} lead
 */
export function leadMatchesAgentFunnel(lead) {
  if (!lead || typeof lead !== 'object') return false
  return (
    Number(lead.pipeline_id) === AGENT_FUNNEL_PIPELINE_ID &&
    AGENT_FUNNEL_STATUS_IDS.includes(Number(lead.status_id))
  )
}

/**
 * @param {object | null | undefined} lead
 */
export function describeLeadFunnel(lead) {
  if (!lead) return 'lead=null'
  return `pipeline_id=${lead.pipeline_id} status_id=${lead.status_id}`
}

/**
 * Verifica se o lead (ou telefone) está na fila permitida da IA.
 *
 * @param {Record<string,string>} env
 * @param {{ leadId?: number, lead?: object, telefone?: string, skip?: boolean }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   lead?: object,
 *   reason?: string,
 *   pipeline_id?: number,
 *   status_id?: number,
 *   matched_leads?: number,
 * }>}
 */
export async function assertLeadInAgentFunnel(env, input = {}) {
  if (input.skip) return { ok: true }

  const { pipelineId, statusIds } = resolveAgentFunnelFromEnv(env)
  void pipelineId
  void statusIds

  if (input.lead && leadMatchesAgentFunnel(input.lead)) {
    return { ok: true, lead: input.lead }
  }

  const leadId = Number(input.leadId)
  if (Number.isFinite(leadId) && leadId > 0) {
    let fetched = input.lead && Number(input.lead.id) === leadId ? input.lead : null
    if (!fetched) {
      const got = await getLeadById(env, leadId)
      fetched = got.ok ? got.lead : null
    }
    if (leadMatchesAgentFunnel(fetched)) {
      return { ok: true, lead: fetched }
    }
    return {
      ok: false,
      reason: 'lead_outside_agent_funnel',
      pipeline_id: fetched?.pipeline_id,
      status_id: fetched?.status_id,
      lead: fetched || undefined,
    }
  }

  const telefone = String(input.telefone || '').replace(/[^0-9]/g, '')
  if (telefone) {
    const lookup = await findLeadByPhone(env, telefone)
    if (!lookup.ok) {
      return { ok: false, reason: 'kommo_lookup_failed', error: lookup.error }
    }
    const candidates = Array.isArray(lookup.leads) ? lookup.leads : lookup.lead ? [lookup.lead] : []
    const inFunnel = candidates.find((l) => leadMatchesAgentFunnel(l))
    if (inFunnel) {
      return { ok: true, lead: inFunnel, matched_leads: candidates.length }
    }
    const first = candidates[0]
    return {
      ok: false,
      reason: 'no_lead_in_agent_funnel',
      pipeline_id: first?.pipeline_id,
      status_id: first?.status_id,
      matched_leads: candidates.length,
    }
  }

  return { ok: false, reason: 'missing_lead_or_phone' }
}
