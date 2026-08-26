/**
 * Adapter CRM — Kommo (default) | EduIT.
 *
 * Env: CRM_BACKEND=kommo|eduit  (default: kommo — deploy seguro)
 *
 * Quando backend=eduit, IDs são CUID string — nunca passar por Number().
 * Funções espelham o caminho quente (lookup, gate, move, nota, outbound).
 */

import {
  findLeadByPhone as kommoFindLeadByPhone,
  getLeadById as kommoGetLeadById,
  createLeadNote as kommoCreateLeadNote,
  updateLeadPipelineStatus as kommoUpdateLeadPipelineStatus,
} from './kommoClient.js'
import {
  assertLeadInAgentFunnel as kommoAssertLeadInAgentFunnel,
  describeLeadFunnel as kommoDescribeLeadFunnel,
  leadMatchesAgentFunnel as kommoLeadMatchesAgentFunnel,
  resolveAgentFunnelFromEnv as kommoResolveAgentFunnelFromEnv,
} from './kommoAgentFunnelGate.js'
import {
  eduitAgentStageIds,
  findContactsByPhone,
  getDealById,
  createDealNote,
  updateDealStage,
  listDealsByStageId,
  listDealsByContactId,
  listConversationsByContactId,
  sendConversationText,
  resolveEduitEntitiesByPhone,
  resolveEduitStages,
  isEduitCuid,
  pickPreferredDeal,
} from './eduitClient.js'
import {
  fetchDadosClienteByTelefone,
  updateDadosCliente,
  isAtendimentoIaPaused,
} from './dadosClienteStore.js'

export function getCrmBackend(env = process.env) {
  const raw = String(env.CRM_BACKEND || 'kommo').trim().toLowerCase()
  return raw === 'eduit' ? 'eduit' : 'kommo'
}

export function isEduitBackend(env = process.env) {
  return getCrmBackend(env) === 'eduit'
}

/**
 * Normaliza id de lead/deal sem destruir CUID.
 * @returns {string|number|null}
 */
export function normalizeCrmLeadId(id, env = process.env) {
  if (id == null || id === '') return null
  const s = String(id).trim()
  if (!s || s === '0') return null
  if (isEduitBackend(env) || isEduitCuid(s) || !/^\d+$/.test(s)) {
    return s
  }
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Lead shape unificado (Kommo numérico ou EduIT deal CUID). */
export function dealToAgentLead(deal, env = process.env) {
  if (!deal || typeof deal !== 'object') return null
  const stages = resolveEduitStages(env)
  const stageId = String(deal.stageId || deal.stage_id || '')
  return {
    id: String(deal.id),
    stageId,
    status_id: stageId,
    pipeline_id: String(deal.pipelineId || deal.pipeline_id || stages.pipelineId || ''),
    number: deal.number ?? null,
    title: deal.title || deal.name || null,
    contactId: deal.contactId || deal.contact_id || null,
    _backend: 'eduit',
    _raw: deal,
  }
}

export function leadMatchesEduitAgentFunnel(lead, env = process.env) {
  if (!lead || typeof lead !== 'object') return false
  const stageId = String(lead.stageId || lead.status_id || '')
  return eduitAgentStageIds(env).includes(stageId)
}

export function describeCrmLeadFunnel(lead) {
  if (!lead) return 'lead=null'
  if (lead._backend === 'eduit' || isEduitCuid(lead.id) || lead.stageId) {
    return `stageId=${lead.stageId || lead.status_id || '?'} dealId=${lead.id || '?'}`
  }
  return kommoDescribeLeadFunnel(lead)
}

export async function findLeadByPhone(env, telefone) {
  if (!isEduitBackend(env)) {
    return kommoFindLeadByPhone(env, telefone)
  }
  const resolved = await resolveEduitEntitiesByPhone(env, telefone)
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code || 'EDUIT_ERROR',
      error: resolved.error,
      matched: 0,
      lead: null,
      leads: [],
    }
  }
  if (!resolved.deal) {
    return {
      ok: true,
      lead: null,
      matched: 0,
      leads: [],
      contactId: resolved.contactId,
      conversationId: resolved.conversationId,
    }
  }
  const lead = dealToAgentLead(resolved.deal, env)
  lead.eduit_contact_id = resolved.contactId
  lead.eduit_conversation_id = resolved.conversationId
  lead.eduit_deal_id = resolved.dealId

  const dealsRes = resolved.contactId
    ? await listDealsByContactId(env, resolved.contactId)
    : { ok: true, deals: resolved.deal ? [resolved.deal] : [] }
  const allLeads = (dealsRes.deals || []).map((d) => {
    const L = dealToAgentLead(d, env)
    L.eduit_contact_id = resolved.contactId
    L.eduit_conversation_id = resolved.conversationId
    L.eduit_deal_id = String(d.id)
    return L
  })
  return {
    ok: true,
    lead,
    matched: allLeads.length,
    leads: allLeads.length ? allLeads : [lead],
    contactId: resolved.contactId,
    conversationId: resolved.conversationId,
    dealPickReason: resolved.dealPickReason,
  }
}

export async function getLeadById(env, leadId) {
  if (!isEduitBackend(env)) {
    return kommoGetLeadById(env, leadId)
  }
  const id = normalizeCrmLeadId(leadId, env)
  if (!id || !isEduitCuid(String(id))) {
    return { ok: false, code: 'MISSING_LEAD_ID', error: 'dealId CUID inválido' }
  }
  const got = await getDealById(env, id)
  if (!got.ok) return { ok: false, code: got.code, status: got.status, error: got.error }
  return { ok: true, lead: dealToAgentLead(got.deal, env), status: got.status }
}

export async function createLeadNote(env, leadId, text) {
  if (!isEduitBackend(env)) {
    return kommoCreateLeadNote(env, leadId, text)
  }
  const id = normalizeCrmLeadId(leadId, env)
  return createDealNote(env, id, text)
}

/**
 * Move etapa. Kommo: pipelineId+statusId. EduIT: stageId (ou statusId alias).
 */
export async function updateLeadPipelineStatus(env, leadId, { pipelineId, statusId, stageId } = {}) {
  if (!isEduitBackend(env)) {
    return kommoUpdateLeadPipelineStatus(env, leadId, { pipelineId, statusId })
  }
  const id = normalizeCrmLeadId(leadId, env)
  const sid = String(stageId || statusId || '').trim()
  return updateDealStage(env, id, sid)
}

export async function listLeadsInAgentQueue(env) {
  if (!isEduitBackend(env)) {
    const { listLeadsInAgentQueue: kommoList } = await import('./kommoAgentFunnel.js')
    return kommoList(env)
  }
  const stageIds = eduitAgentStageIds(env)
  const byId = new Map()
  let lastError = null
  let lastStatus = null
  for (const stageId of stageIds) {
    const listing = await listDealsByStageId(env, stageId)
    if (!listing.ok) {
      lastError = listing.error || listing.code || `stage_${stageId}`
      lastStatus = listing.status ?? null
      continue
    }
    for (const deal of listing.deals || []) {
      const id = String(deal?.id || '')
      if (id && isEduitCuid(id)) byId.set(id, dealToAgentLead(deal, env))
    }
  }
  const leads = [...byId.values()]
  return {
    ok: leads.length > 0 || !lastError,
    leads,
    statusIds: stageIds,
    error: leads.length === 0 ? lastError : undefined,
    httpStatus: lastStatus,
  }
}

export function resolveAgentFunnelFromEnv(env) {
  if (!isEduitBackend(env)) {
    return kommoResolveAgentFunnelFromEnv(env)
  }
  const stages = resolveEduitStages(env)
  return {
    pipelineId: stages.pipelineId,
    statusIds: eduitAgentStageIds(env),
  }
}

export function leadMatchesAgentFunnel(lead, context = {}) {
  const env = context.env || process.env
  if (!isEduitBackend(env)) {
    return kommoLeadMatchesAgentFunnel(lead, context)
  }
  return leadMatchesEduitAgentFunnel(lead, env)
}

/**
 * Persiste CUIDs EduIT + id_lead=deal CUID em dados_cliente_sum.
 */
export async function persistEduitIds(env, telefone, { dealId, contactId, conversationId } = {}) {
  const fields = {}
  if (dealId) {
    const d = String(dealId).trim()
    if (isEduitCuid(d)) {
      fields.eduit_deal_id = d
      fields.id_lead = d
    }
  }
  if (contactId) {
    const c = String(contactId).trim()
    if (isEduitCuid(c)) fields.eduit_contact_id = c
  }
  if (conversationId) {
    const v = String(conversationId).trim()
    if (isEduitCuid(v)) fields.eduit_conversation_id = v
  }
  if (!Object.keys(fields).length) {
    return { ok: false, code: 'MISSING_IDS', error: 'nenhum CUID válido para persistir' }
  }
  return updateDadosCliente(env, { telefone, fields })
}

/**
 * Lê IDs já gravados; completa via API se faltar (sem criar entidades).
 */
export async function resolveAndPersistEduitIds(env, telefone) {
  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    'id_lead,eduit_deal_id,eduit_contact_id,eduit_conversation_id',
  )
  let dealId = row?.eduit_deal_id || (isEduitCuid(row?.id_lead) ? row.id_lead : null)
  let contactId = row?.eduit_contact_id || null
  let conversationId = row?.eduit_conversation_id || null

  if (dealId && contactId && conversationId) {
    return {
      ok: true,
      dealId: String(dealId),
      contactId: String(contactId),
      conversationId: String(conversationId),
      fromCache: true,
    }
  }

  const resolved = await resolveEduitEntitiesByPhone(env, telefone)
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, code: resolved.code }
  }
  dealId = dealId || resolved.dealId
  contactId = contactId || resolved.contactId
  conversationId = conversationId || resolved.conversationId

  if (dealId || contactId || conversationId) {
    await persistEduitIds(env, telefone, { dealId, contactId, conversationId }).catch(() => {})
  }

  return {
    ok: true,
    dealId: dealId ? String(dealId) : null,
    contactId: contactId ? String(contactId) : null,
    conversationId: conversationId ? String(conversationId) : null,
    deal: resolved.deal || null,
    dealPickReason: resolved.dealPickReason,
    fromCache: false,
  }
}

/**
 * Lead de Entrada → Atendimento no primeiro inbound (respeita pause).
 * Não cria contato/deal. Outras etapas: não move.
 */
export async function ensureEduitDealReadyForAgent(env, { telefone } = {}) {
  if (!isEduitBackend(env)) {
    return { ok: true, skipped: true, reason: 'backend_kommo' }
  }
  const digits = String(telefone || '').replace(/[^0-9]/g, '')
  if (!digits) {
    return { ok: false, reason: 'missing_telefone' }
  }

  if (await isAtendimentoIaPaused(env, digits)) {
    return { ok: false, reason: 'ia_paused', hold: true }
  }

  const ids = await resolveAndPersistEduitIds(env, digits)
  if (!ids.ok) {
    return { ok: false, reason: 'eduit_resolve_failed', error: ids.error }
  }
  if (!ids.dealId) {
    return { ok: false, reason: 'deal_not_found', contactId: ids.contactId }
  }

  let lead = ids.deal ? dealToAgentLead(ids.deal, env) : null
  if (!lead) {
    const got = await getDealById(env, ids.dealId)
    if (got.ok) lead = dealToAgentLead(got.deal, env)
  }
  if (!lead) {
    return { ok: false, reason: 'deal_fetch_failed', dealId: ids.dealId }
  }

  lead.eduit_contact_id = ids.contactId
  lead.eduit_conversation_id = ids.conversationId
  lead.eduit_deal_id = ids.dealId

  const stages = resolveEduitStages(env)
  const stageId = String(lead.stageId || '')

  if (eduitAgentStageIds(env).includes(stageId)) {
    return {
      ok: true,
      lead,
      moved: false,
      dealId: ids.dealId,
      contactId: ids.contactId,
      conversationId: ids.conversationId,
    }
  }

  if (stageId === stages.entrada) {
    const move = await updateDealStage(env, ids.dealId, stages.atendimento)
    if (!move.ok) {
      return {
        ok: false,
        reason: 'move_entrada_failed',
        error: move.error,
        lead,
        dealId: ids.dealId,
      }
    }
    lead.stageId = stages.atendimento
    lead.status_id = stages.atendimento
    await createDealNote(
      env,
      ids.dealId,
      'Encaminhamento automático: inbound Meta — Lead de Entrada → Atendimento (agente IA)',
    ).catch(() => {})
    return {
      ok: true,
      lead,
      moved: true,
      from: stages.entrada,
      to: stages.atendimento,
      dealId: ids.dealId,
      contactId: ids.contactId,
      conversationId: ids.conversationId,
    }
  }

  return {
    ok: false,
    reason: 'lead_outside_agent_funnel',
    lead,
    stageId,
    dealId: ids.dealId,
    contactId: ids.contactId,
    conversationId: ids.conversationId,
  }
}

/**
 * Gate do funil — Kommo intacto; EduIT usa stages CUID + Entrada move.
 */
export async function assertLeadInAgentFunnel(env, input = {}) {
  if (!isEduitBackend(env)) {
    return kommoAssertLeadInAgentFunnel(env, input)
  }
  if (input.skip) return { ok: true }

  if (input.lead && leadMatchesEduitAgentFunnel(input.lead, env)) {
    return { ok: true, lead: input.lead }
  }

  const leadId = normalizeCrmLeadId(input.leadId, env)
  if (leadId && isEduitCuid(String(leadId))) {
    let fetched = input.lead && String(input.lead.id) === String(leadId) ? input.lead : null
    if (!fetched) {
      const got = await getLeadById(env, leadId)
      fetched = got.ok ? got.lead : null
    }
    if (leadMatchesEduitAgentFunnel(fetched, env)) {
      return { ok: true, lead: fetched }
    }
    // Se Entrada e temos telefone, tenta mover
    const stages = resolveEduitStages(env)
    if (
      fetched &&
      String(fetched.stageId || fetched.status_id) === stages.entrada &&
      input.telefone
    ) {
      const ready = await ensureEduitDealReadyForAgent(env, { telefone: input.telefone })
      if (ready.ok && ready.lead) return { ok: true, lead: ready.lead, moved: ready.moved }
    }
    return {
      ok: false,
      reason: 'lead_outside_agent_funnel',
      pipeline_id: fetched?.pipeline_id,
      status_id: fetched?.stageId || fetched?.status_id,
      lead: fetched || undefined,
    }
  }

  const telefone = String(input.telefone || '').replace(/[^0-9]/g, '')
  if (telefone) {
    const ready = await ensureEduitDealReadyForAgent(env, { telefone })
    if (ready.hold) {
      return { ok: false, reason: 'ia_paused' }
    }
    if (ready.ok && ready.lead) {
      return { ok: true, lead: ready.lead, moved: ready.moved }
    }
    return {
      ok: false,
      reason: ready.reason || 'no_lead_in_agent_funnel',
      pipeline_id: ready.lead?.pipeline_id,
      status_id: ready.lead?.stageId || ready.stageId,
      lead: ready.lead,
    }
  }

  return { ok: false, reason: 'missing_lead_or_phone' }
}

/**
 * Outbound EduIT: só POST conversa. Resolve conversationId e persiste.
 */
export async function sendEduitOutboundText(env, { telefone, text, conversationId } = {}) {
  let convId = conversationId ? String(conversationId).trim() : ''
  if (!convId || !isEduitCuid(convId)) {
    const ids = await resolveAndPersistEduitIds(env, telefone)
    if (!ids.ok || !ids.conversationId) {
      return {
        ok: false,
        code: 'EDUIT_CONVERSATION_MISSING',
        error: ids.error || 'eduit_conversation_id não encontrado',
      }
    }
    convId = ids.conversationId
  } else {
    // Garante persistência se já veio pronto
    await persistEduitIds(env, telefone, { conversationId: convId }).catch(() => {})
  }
  return sendConversationText(env, convId, text)
}

// Re-export utilitários usados por testes / scripts
export {
  findContactsByPhone,
  listConversationsByContactId,
  pickPreferredDeal,
  resolveEduitStages,
  eduitAgentStageIds,
  isEduitCuid,
}
