/**
 * Trinco fixo do funil da IA — Faculdade Sumaré.
 *
 * O agente automático (scheduler + flush WhatsApp) atende leads em:
 *   pipeline_id = 13756724 (Agente-Sumaré)
 *   status_id   ∈ { 106140284 (Atendimento), 106804680 (inscrição) }
 *
 * Exceção (API_SUMARE_ADVANCED_FUNNEL_ENABLED): leads com sum_Origem "Api Sumaré"
 * na fila "aguardando pagamento" (106426128) também entram no funil — chegam
 * sem atendimento prévio e precisam de bootstrap por CPF + comprovante.
 *
 * Em "inscrição" a IA segue até o comprovante; após comprovante o lead vai para
 * "aguardando pagamento" e a IA pausa — exceto os casos Api Sumaré acima.
 *
 * Valores de KOMMO_AGENT_* no .env que divergirem são ignorados (com warn no boot).
 */

import { findLeadByPhone, getLeadById } from './kommoClient.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import {
  isApiSumareAdvancedFunnelEnabled,
  isApiSumareOrigemValue,
} from '../libShared/apiSumareOrigemHeuristics.js'

/** @type {const} */
export const AGENT_FUNNEL_PIPELINE_ID = 13756724

/** Etapa "Atendimento" (primária). @type {const} */
export const AGENT_FUNNEL_STATUS_ID = 106140284

/** Etapa "inscrição" — IA continua atendendo até o comprovante. @type {const} */
export const AGENT_FUNNEL_STATUS_INSCRICAO = 106804680

/** Etapa "aguardando pagamento" — só Api Sumaré (quando feature ligada). @type {const} */
export const AGENT_FUNNEL_STATUS_AGUARDANDO_PAGAMENTO = 106426128

/** Etapas atendidas pela IA (sem pagamento — ver resolveAgentFunnelFromEnv). */
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
      `usando pipeline=${AGENT_FUNNEL_PIPELINE_ID} status base=[${AGENT_FUNNEL_STATUS_IDS.join(',')}] (+ Api Sumaré pagamento se habilitado).`,
  )
}

/**
 * IDs efetivos do funil (fixos + pagamento condicional Api Sumaré).
 * @returns {{ pipelineId: number, statusIds: number[] }}
 */
export function resolveAgentFunnelFromEnv(env) {
  warnEnvMismatchOnce(env)
  const statusIds = [...AGENT_FUNNEL_STATUS_IDS]
  if (isApiSumareAdvancedFunnelEnabled(env)) {
    statusIds.push(AGENT_FUNNEL_STATUS_AGUARDANDO_PAGAMENTO)
  }
  return {
    pipelineId: AGENT_FUNNEL_PIPELINE_ID,
    statusIds,
  }
}

const ORIGEM_FIELD_ALIASES = ['sum_origem', 'sum origem', 'origem']

function pickOrigemFromCustomFields(custom) {
  if (!Array.isArray(custom)) return ''
  for (const f of custom) {
    const name = String(f?.field_name || f?.name || '').trim().toLowerCase()
    if (!ORIGEM_FIELD_ALIASES.includes(name)) continue
    const v = f?.values?.[0]?.value
    if (v != null && String(v).trim()) return String(v).trim()
  }
  return ''
}

/** Lê sum_Origem do objeto lead (lista Kommo) quando disponível. */
export function extractOrigemFromLead(lead) {
  if (!lead || typeof lead !== 'object') return ''
  const fromCustom = pickOrigemFromCustomFields(lead.custom_fields_values)
  if (fromCustom) return fromCustom
  if (lead.origem != null && String(lead.origem).trim()) return String(lead.origem).trim()
  return ''
}

/**
 * @param {object | null | undefined} lead
 * @param {{ env?: object, origem?: string }} [context]
 */
export function leadMatchesAgentFunnel(lead, context = {}) {
  if (!lead || typeof lead !== 'object') return false
  if (Number(lead.pipeline_id) !== AGENT_FUNNEL_PIPELINE_ID) return false

  const statusId = Number(lead.status_id)
  if (AGENT_FUNNEL_STATUS_IDS.includes(statusId)) return true

  if (statusId === AGENT_FUNNEL_STATUS_AGUARDANDO_PAGAMENTO) {
    const env = context.env || process.env
    if (!isApiSumareAdvancedFunnelEnabled(env)) return false
    const origem = context.origem != null ? context.origem : extractOrigemFromLead(lead)
    return isApiSumareOrigemValue(origem)
  }

  return false
}

/**
 * @param {object | null | undefined} lead
 */
export function describeLeadFunnel(lead) {
  if (!lead) return 'lead=null'
  return `pipeline_id=${lead.pipeline_id} status_id=${lead.status_id}`
}

async function resolveOrigemForLead(env, lead) {
  if (!lead?.id) return extractOrigemFromLead(lead)
  let origem = extractOrigemFromLead(lead)
  if (origem) return origem
  if (Number(lead.status_id) !== AGENT_FUNNEL_STATUS_AGUARDANDO_PAGAMENTO) return ''
  try {
    const snap = await fetchLeadFormSnapshot(env, Number(lead.id))
    if (snap.ok && snap.snapshot?.origem) return String(snap.snapshot.origem).trim()
  } catch {
    /* ignore */
  }
  return ''
}

async function leadInFunnel(env, lead) {
  if (!lead) return false
  if (Number(lead.status_id) === AGENT_FUNNEL_STATUS_AGUARDANDO_PAGAMENTO) {
    const origem = await resolveOrigemForLead(env, lead)
    return leadMatchesAgentFunnel(lead, { env, origem })
  }
  return leadMatchesAgentFunnel(lead, { env })
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

  if (input.lead && (await leadInFunnel(env, input.lead))) {
    return { ok: true, lead: input.lead }
  }

  const leadId = Number(input.leadId)
  if (Number.isFinite(leadId) && leadId > 0) {
    let fetched = input.lead && Number(input.lead.id) === leadId ? input.lead : null
    if (!fetched) {
      const got = await getLeadById(env, leadId)
      fetched = got.ok ? got.lead : null
    }
    if (await leadInFunnel(env, fetched)) {
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
    for (const l of candidates) {
      if (await leadInFunnel(env, l)) {
        return { ok: true, lead: l, matched_leads: candidates.length }
      }
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
