/**
 * Listagem de leads na fila do agente (Kommo).
 *
 * IDs fixos em kommoAgentFunnelGate.js:
 *   pipeline 13756724 (Agente-Sumaré)
 *   status   106140284 (Atendimento)
 *
 * KOMMO_AGENT_PIPELINE_ID / KOMMO_AGENT_STATUS_ID no .env são apenas
 * referência — se divergirem, o gate ignora e usa os fixos.
 */

import { listLeadsByStatus } from './kommoClient.js'
import { resolveAgentFunnelFromEnv } from './kommoAgentFunnelGate.js'

/** @deprecated Use resolveAgentFunnelFromEnv — mantido para imports legados. */
export function parseAgentStatusIds(env) {
  return resolveAgentFunnelFromEnv(env).statusIds
}

/**
 * Lista leads na fila fixa do agente.
 * @returns {Promise<{ ok: boolean, leads: object[], statusIds: number[], error?: string }>}
 */
export async function listLeadsInAgentQueue(env) {
  const { pipelineId, statusIds } = resolveAgentFunnelFromEnv(env)
  if (!statusIds.length) {
    return { ok: false, leads: [], statusIds: [], error: 'missing_status_ids' }
  }

  const byId = new Map()
  let lastError = null
  let lastStatus = null

  for (const statusId of statusIds) {
    const listing = await listLeadsByStatus(env, { pipelineId, statusId })
    if (!listing.ok) {
      lastError = listing.error || listing.code || `status_${statusId}`
      lastStatus = listing.status ?? null
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
    httpStatus: lastStatus,
  }
}
