/**
 * Ciclo de sessão da fila do agente (KOMMO_AGENT_PIPELINE_ID + KOMMO_AGENT_STATUS_ID).
 *
 * Saída da fila → encerra a sessão de atendimento (buffer, memória IA, poll Kommo).
 * Reentrada na fila → nova sessão: o agente trata como atendimento novo, sem
 * reprocessar notas/mensagens antigas do ciclo anterior.
 *
 * Liga/desliga: AGENT_QUEUE_SESSION_ENABLED (default true).
 */

import { clearMessages } from './evolution/messageBuffer.js'
import {
  updateDadosCliente,
  normalizeTelefone,
  fetchDadosClienteByTelefone,
} from './dadosClienteStore.js'
import { clearAgentConversationMemory } from './historyStore.js'
import { resetKommoInboundPollStateForLead } from './kommoInboundPoll.js'
import { matriculaPosFormAlreadyProcessed } from '../libShared/inscricaoFormHeuristics.js'
import { DADOS_CLIENTE_INSCRICAO_SELECT } from './dadosClienteInscricaoFields.js'
import { phoneToWhatsAppSessionId } from './phoneWhatsApp.js'
import { getLeadSummary } from './kommoClient.js'

/** leadId → epoch ms — notas Kommo anteriores a este instante são ignoradas no pós-form. */
const noteCutoffMsByLeadId = new Map()

export function isAgentQueueSessionEnabled(env) {
  const raw = String(env.AGENT_QUEUE_SESSION_ENABLED ?? 'true').trim().toLowerCase()
  return !['false', '0', 'no', 'off'].includes(raw)
}

function shouldClearMemory(env) {
  const raw = String(env.AGENT_QUEUE_SESSION_CLEAR_MEMORY ?? 'true').trim().toLowerCase()
  return !['false', '0', 'no', 'off'].includes(raw)
}

/** ISO para detectFormSumarRecebidoNoKommo (corte de notas antigas na reentrada). */
export function getAgentQueueSessionCutoffIso(leadId) {
  const ms = noteCutoffMsByLeadId.get(Number(leadId))
  if (!Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms).toISOString()
}

function setNoteCutoffNow(leadId) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) return
  noteCutoffMsByLeadId.set(id, Date.now())
}

function clearNoteCutoff(leadId) {
  const id = Number(leadId)
  if (Number.isFinite(id) && id > 0) noteCutoffMsByLeadId.delete(id)
}

async function resolvePhone(env, leadId, telefone) {
  const hinted = telefone ? normalizeTelefone(telefone) : ''
  if (hinted) return hinted
  const summary = await getLeadSummary(env, leadId)
  if (summary.ok && summary.phone) return normalizeTelefone(summary.phone)
  return null
}

/**
 * Lead saiu da fila do agente — encerra sessão.
 */
export async function endAgentQueueSession(env, { leadId, telefone, sessionId, reason = 'funnel_exit' } = {}) {
  if (!isAgentQueueSessionEnabled(env)) {
    return { ok: true, skipped: true, reason: 'disabled' }
  }
  const lid = Number(leadId)
  const phone = await resolvePhone(env, lid, telefone)
  if (!phone) {
    return { ok: false, reason: 'no_phone', leadId: lid }
  }
  const sid = sessionId || phoneToWhatsAppSessionId(phone)
  if (!sid) return { ok: false, reason: 'no_session_id', leadId: lid }

  const row = await fetchDadosClienteByTelefone(env, phone, DADOS_CLIENTE_INSCRICAO_SELECT)
  const matriculaDone = matriculaPosFormAlreadyProcessed(row)

  const fields = {
    atendimento_ia: null,
    reativacao_ping_at: null,
    reativacao_moved_at: null,
  }
  if (!matriculaDone) {
    fields.inscricao_form_status = null
    fields.inscricao_form_recebido_at = null
  }

  const bufferRemoved = await clearMessages(env, sid)
  let memoryRemoved = 0
  if (shouldClearMemory(env)) {
    const mem = await clearAgentConversationMemory(env, phone)
    memoryRemoved = mem.removed || 0
  }
  if (Number.isFinite(lid) && lid > 0) {
    resetKommoInboundPollStateForLead(lid)
    clearNoteCutoff(lid)
  }

  const patch = await updateDadosCliente(env, { telefone: phone, fields }).catch((err) => ({
    ok: false,
    error: err.message,
  }))

  console.log(
    `[agentQueueSession] end lead=${lid} phone=${phone} reason=${reason} matriculaDone=${matriculaDone} buffer=${bufferRemoved} memory=${memoryRemoved}`,
  )

  return {
    ok: true,
    action: 'end',
    leadId: lid,
    telefone: phone,
    sessionId: sid,
    matriculaDone,
    bufferRemoved,
    memoryRemoved,
    dadosCliente: patch,
  }
}

/**
 * Lead voltou à fila — inicia nova sessão de atendimento.
 */
export async function beginAgentQueueSession(env, { leadId, telefone, sessionId, reason = 'funnel_reentry' } = {}) {
  if (!isAgentQueueSessionEnabled(env)) {
    return { ok: true, skipped: true, reason: 'disabled' }
  }
  const lid = Number(leadId)
  const phone = await resolvePhone(env, lid, telefone)
  if (!phone) {
    return { ok: false, reason: 'no_phone', leadId: lid }
  }
  const sid = sessionId || phoneToWhatsAppSessionId(phone)
  if (!sid) return { ok: false, reason: 'no_session_id', leadId: lid }

  const row = await fetchDadosClienteByTelefone(env, phone, DADOS_CLIENTE_INSCRICAO_SELECT)
  const matriculaDone = matriculaPosFormAlreadyProcessed(row)

  const fields = {
    atendimento_ia: null,
    reativacao_ping_at: null,
    reativacao_moved_at: null,
  }
  if (!matriculaDone) {
    fields.inscricao_form_status = null
  }

  const bufferRemoved = await clearMessages(env, sid)
  let memoryRemoved = 0
  if (shouldClearMemory(env)) {
    const mem = await clearAgentConversationMemory(env, phone)
    memoryRemoved = mem.removed || 0
  }
  if (Number.isFinite(lid) && lid > 0) {
    resetKommoInboundPollStateForLead(lid)
    setNoteCutoffNow(lid)
  }

  const patch = await updateDadosCliente(env, { telefone: phone, fields }).catch((err) => ({
    ok: false,
    error: err.message,
  }))

  console.log(
    `[agentQueueSession] begin lead=${lid} phone=${phone} reason=${reason} matriculaDone=${matriculaDone} buffer=${bufferRemoved} memory=${memoryRemoved} noteCutoff=${getAgentQueueSessionCutoffIso(lid)}`,
  )

  return {
    ok: true,
    action: 'begin',
    leadId: lid,
    telefone: phone,
    sessionId: sid,
    matriculaDone,
    bufferRemoved,
    memoryRemoved,
    noteCutoffIso: getAgentQueueSessionCutoffIso(lid),
    dadosCliente: patch,
  }
}

/**
 * Resolve telefone para leads que saíram do funil (não estão no bulk do tick atual).
 */
export async function endAgentQueueSessionsForLeads(env, leadIds, { reason = 'funnel_exit' } = {}) {
  if (!isAgentQueueSessionEnabled(env) || !Array.isArray(leadIds) || !leadIds.length) {
    return { processed: 0, results: [] }
  }
  const results = await Promise.all(
    leadIds.map((id) => endAgentQueueSession(env, { leadId: id, reason })),
  )
  return { processed: results.filter((r) => r.ok).length, results }
}
