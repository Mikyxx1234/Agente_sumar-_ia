/**
 * Ciclo de sessão da fila do agente (KOMMO_AGENT_PIPELINE_ID + KOMMO_AGENT_STATUS_ID).
 *
 * Saída da fila → encerra a sessão de atendimento (buffer, memória IA, poll Kommo).
 * Reentrada na fila → nova sessão: o agente trata como atendimento novo, sem
 * reprocessar notas/mensagens antigas do ciclo anterior.
 *
 * Liga/desliga: AGENT_QUEUE_SESSION_ENABLED (default true).
 */

import { clearMessages, getMessages } from './evolution/messageBuffer.js'
import { flushSession } from './evolution/webhookEvolution.js'
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

/** Evita end+begin em flips rápidos de status no Kommo (ex.: Atendimento ↔ Aguardando resposta). */
const lastEndMsByLeadId = new Map()

function reentryGraceMs(env) {
  const sec = Number(env.AGENT_QUEUE_SESSION_REENTRY_GRACE_SEC)
  return Number.isFinite(sec) && sec > 0 ? Math.floor(sec) * 1000 : 120_000
}

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

  if (Number.isFinite(lid) && lid > 0) {
    const grace = reentryGraceMs(env)
    const lastEnd = lastEndMsByLeadId.get(lid)
    if (lastEnd && Date.now() - lastEnd < grace) {
      console.log(
        `[agentQueueSession] end skip lead=${lid} (reentry grace ${Math.round((grace - (Date.now() - lastEnd)) / 1000)}s restantes)`,
      )
      return { ok: true, skipped: true, reason: 'reentry_grace', leadId: lid }
    }
  }

  let flushedBeforeEnd = false
  let flushSkippedReason = null
  try {
    const pending = await getMessages(env, sid)
    if (pending?.length > 0) {
      console.log(
        `[agentQueueSession] end lead=${lid} flush antes de encerrar (${pending.length} msg(s) no buffer)`,
      )
      const flushRes = await flushSession(env, sid, { leadIdHint: lid > 0 ? lid : null })
      // flushSession devolve:
      //   - null            → drain rodou, nada havia (ou foi processado) → OK limpar
      //   - { ok: true/... }→ rodou completo (sucesso ou erro de IA) → OK limpar
      //   - { skipped: X }  → flush foi held (claim/cooldown/pause) — buffer NÃO foi consumido
      if (flushRes && flushRes.skipped) {
        flushSkippedReason = flushRes.skipped
      } else {
        flushedBeforeEnd = true
      }
    }
  } catch (flushErr) {
    console.warn(`[agentQueueSession] end flush lead=${lid}:`, flushErr.message)
    flushSkippedReason = flushSkippedReason || 'flush_exception'
  }

  // Só limpa buffer se o flush realmente consumiu (ou nem precisava rodar).
  // Quando o flush foi held (claim ocupado em outra réplica, cooldown, IA
  // pausada), as mensagens devem permanecer pro próximo tick processar.
  let bufferRemoved = 0
  if (!flushSkippedReason) {
    bufferRemoved = await clearMessages(env, sid)
  } else {
    console.log(
      `[agentQueueSession] end lead=${lid} buffer PRESERVADO — flush_skipped=${flushSkippedReason}`,
    )
  }
  let memoryRemoved = 0
  if (shouldClearMemory(env)) {
    const mem = await clearAgentConversationMemory(env, phone)
    memoryRemoved = mem.removed || 0
  }
  if (Number.isFinite(lid) && lid > 0) {
    resetKommoInboundPollStateForLead(lid)
    clearNoteCutoff(lid)
    lastEndMsByLeadId.set(lid, Date.now())
  }

  const patch = await updateDadosCliente(env, { telefone: phone, fields }).catch((err) => ({
    ok: false,
    error: err.message,
  }))

  console.log(
    `[agentQueueSession] end lead=${lid} phone=${phone} reason=${reason} matriculaDone=${matriculaDone} buffer=${bufferRemoved} memory=${memoryRemoved}${flushSkippedReason ? ` flush_skipped=${flushSkippedReason}` : ''}`,
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
    flushedBeforeEnd,
    flushSkippedReason,
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

  if (Number.isFinite(lid) && lid > 0) {
    const grace = reentryGraceMs(env)
    const lastEnd = lastEndMsByLeadId.get(lid)
    if (lastEnd && Date.now() - lastEnd < grace) {
      console.log(`[agentQueueSession] begin skip lead=${lid} (mesmo ciclo — grace após end)`)
      return { ok: true, skipped: true, reason: 'reentry_grace', leadId: lid }
    }
    lastEndMsByLeadId.delete(lid)
  }

  // Não limpa o buffer na reentrada — mensagens pendentes do lead devem ser processadas.
  const bufferRemoved = 0
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
