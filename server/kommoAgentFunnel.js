/**
 * Funil do agente — um ou vários status_id no mesmo pipeline.
 *
 * KOMMO_AGENT_STATUS_ID          status principal (obrig. no scheduler)
 * KOMMO_AGENT_STATUS_IDS         CSV opcional — ex: 106140284,106377088
 *                                (Atendimento + Aguardando resposta). Evita
 *                                encerrar sessão quando o Kommo só troca etapa
 *                                dentro da fila do agente.
 */

import { listLeadsByStatus } from './kommoClient.js'

/**
 * @returns {number[]}
 */
export function parseAgentStatusIds(env) {
  const primary = Number(env.KOMMO_AGENT_STATUS_ID)
  const raw = String(env.KOMMO_AGENT_STATUS_IDS || '').trim()
  const fromCsv = raw
    ? raw
        .split(/[,\s;]+/)
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    : []
  const set = new Set(fromCsv)
  if (Number.isFinite(primary) && primary > 0) set.add(primary)
  return [...set]
}

/**
 * Lista leads em qualquer status configurado (dedupe por lead id).
 * @returns {Promise<{ ok: boolean, leads: object[], statusIds: number[], error?: string }>}
 */
export async function listLeadsInAgentQueue(env) {
  const pipelineId = Number(env.KOMMO_AGENT_PIPELINE_ID)
  const statusIds = parseAgentStatusIds(env)
  if (!statusIds.length) {
    return { ok: false, leads: [], statusIds: [], error: 'missing_status_ids' }
  }

  const byId = new Map()
  let lastError = null

  for (const statusId of statusIds) {
    const listing = await listLeadsByStatus(env, { pipelineId, statusId })
    if (!listing.ok) {
      lastError = listing.error || listing.code || `status_${statusId}`
      continue
    }
    for (const lead of listing.leads || []) {
      const id = Number(lead?.id)
      if (Number.isFinite(id) && id > 0) byId.set(id, lead)
    }
  }

  const leads = [...byId.values()]
  return {
    ok: leads.length > 0 || !lastError,
    leads,
    statusIds,
    error: leads.length === 0 ? lastError : undefined,
  }
}
