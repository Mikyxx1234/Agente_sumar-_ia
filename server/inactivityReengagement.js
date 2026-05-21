/**
 * Reativação por inatividade do lead no funil do agente:
 *   1) ≥20 min sem resposta do candidato → mensagem de ativação (ping)
 *   2) Ping enviado e ainda sem resposta → move para fila configurada no Kommo
 *
 * Env (defaults = funil Agente-Sumaré):
 *   INATIVIDADE_ENABLED=false   (default off — evita ping durante testes de matrícula)
 *   INATIVIDADE_IDLE_MIN=20
 *   INATIVIDADE_AFTER_PING_MIN=20
 *   INATIVIDADE_PIPELINE_ID=13756724
 *   INATIVIDADE_MOVE_STATUS_ID=106377088
 *   KOMMO_AGENT_PIPELINE_ID / KOMMO_AGENT_STATUS_ID — só processa leads nesta etapa
 */

import { fetchRecentChatRows } from './historyStore.js'
import { sendMessageWithNote } from './whatsappSender.js'
import { saveConversation } from './historyStore.js'
import {
  updateDadosCliente,
  normalizeTelefone,
  fetchDadosClienteByTelefone,
  dadosClienteTelefoneOrFilter,
} from './dadosClienteStore.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
} from '../libShared/inscricaoFormHeuristics.js'
import { updateLeadPipelineStatus } from './kommoClient.js'
import { generateExecutionId } from './ai/executionTelemetry.js'
import { createLeadNote } from './kommoClient.js'

const PING_MESSAGES = [
  'Oi, ainda está aí? 😊',
  'O que achou da minha última mensagem?',
  'Gostou dessa oferta?',
  'Posso te ajudar com mais alguma dúvida sobre o curso?',
  'Ficou alguma pergunta sobre a matrícula ou os valores?',
  'Quer que eu te explique melhor as condições que comentei?',
]

const FIELD_PING_AT = 'reativacao_ping_at'
const FIELD_MOVED_AT = 'reativacao_moved_at'
const FORM_STATUS_FIELD = 'inscricao_form_status'

const SKIP_INSCRICAO_STATUSES = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
])

/** Dedupe em memória se colunas Supabase ainda não existirem. */
const _pingMemory = new Map()
const PING_MEMORY_TTL_MS = 6 * 60 * 60 * 1000

function isEnabled(env) {
  const flag = String(env.INATIVIDADE_ENABLED ?? 'false').trim().toLowerCase()
  return !['false', '0', 'no', 'off'].includes(flag)
}

function idleMs(env) {
  const min = Number(env.INATIVIDADE_IDLE_MIN || 20)
  return (Number.isFinite(min) && min > 0 ? min : 20) * 60 * 1000
}

function afterPingMs(env) {
  const min = Number(env.INATIVIDADE_AFTER_PING_MIN || env.INATIVIDADE_IDLE_MIN || 20)
  return (Number.isFinite(min) && min > 0 ? min : 20) * 60 * 1000
}

function targetMove(env) {
  return {
    pipelineId: Number(env.INATIVIDADE_PIPELINE_ID || env.KOMMO_AGENT_PIPELINE_ID || 13756724),
    statusId: Number(env.INATIVIDADE_MOVE_STATUS_ID || 106377088),
  }
}

function agentFunnelFilter(env) {
  return {
    pipelineId: Number(env.KOMMO_AGENT_PIPELINE_ID || 0),
    statusId: Number(env.KOMMO_AGENT_STATUS_ID || 0),
  }
}

function pickPingMessage(leadId) {
  const idx = Math.abs(Number(leadId) || 0) % PING_MESSAGES.length
  return PING_MESSAGES[idx]
}

function parseTs(iso) {
  if (!iso) return null
  const t = Date.parse(String(iso))
  return Number.isNaN(t) ? null : t
}

/**
 * Analisa chat_messages: última fala do lead e se houve resposta após um instante.
 */
function analyzeChatRows(rows, { sinceIso } = {}) {
  const since = parseTs(sinceIso)
  const chronological = [...(rows || [])].reverse()
  let lastLeadAt = null
  let lastBotAt = null
  let leadRepliedAfterSince = false

  for (const row of chronological) {
    const at = parseTs(row?.created_at)
    if (at == null) continue
    const user = String(row?.user_message || '').trim()
    const bot = String(row?.bot_message || '').trim()
    if (user) {
      lastLeadAt = at
      if (since != null && at > since) leadRepliedAfterSince = true
    }
    if (bot) lastBotAt = at
  }

  const lastSpeaker =
    lastLeadAt != null && lastBotAt != null
      ? lastLeadAt > lastBotAt
        ? 'lead'
        : lastBotAt > lastLeadAt
          ? 'assistant'
          : 'assistant'
      : lastLeadAt != null
        ? 'lead'
        : lastBotAt != null
          ? 'assistant'
          : null

  return {
    lastLeadAt,
    lastBotAt,
    lastSpeaker,
    leadRepliedAfterSince,
    hasAnyBot: lastBotAt != null,
    hasAnyLead: lastLeadAt != null,
  }
}

function getDadosClienteCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum',
  }
}

async function getClienteReativacao(env, telefone) {
  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    `atendimento_ia,${FIELD_PING_AT},${FIELD_MOVED_AT},${FORM_STATUS_FIELD}`,
  )
  return row || {}
}

/**
 * Só uma réplica envia o ping: PATCH com reativacao_ping_at=null.
 */
async function claimReativacaoPingExclusive(env, telefone) {
  const { url, key, table } = getDadosClienteCfg(env)
  const telFilter = dadosClienteTelefoneOrFilter(telefone)
  if (!url || !key || !telFilter) return false
  const nowIso = new Date().toISOString()
  try {
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?${telFilter}&${FIELD_PING_AT}=is.null`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ [FIELD_PING_AT]: nowIso }),
      },
    )
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    return res.ok && Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}

async function setReativacaoFields(env, telefone, fields) {
  try {
    return await updateDadosCliente(env, { telefone, fields })
  } catch {
    return { ok: false }
  }
}

/**
 * @param {object} ctx — { env, telefone, leadId, sessionId, lead }
 */
export async function tryInactivityReengagement(env, ctx) {
  if (!isEnabled(env)) return { action: 'disabled' }

  const telefone = ctx?.telefone
  const leadId = Number(ctx?.leadId)
  const sessionId = ctx?.sessionId
  const lead = ctx?.lead

  if (!telefone || !Number.isFinite(leadId) || leadId <= 0 || !sessionId) {
    return { action: 'skip', reason: 'missing_context' }
  }

  const funnel = agentFunnelFilter(env)
  const leadPipeline = Number(lead?.pipeline_id)
  const leadStatus = Number(lead?.status_id)
  if (funnel.pipelineId > 0 && leadPipeline !== funnel.pipelineId) {
    return { action: 'skip', reason: 'wrong_pipeline' }
  }
  if (funnel.statusId > 0 && leadStatus !== funnel.statusId) {
    return { action: 'skip', reason: 'wrong_status' }
  }

  const moveTarget = targetMove(env)
  if (leadStatus === moveTarget.statusId && leadPipeline === moveTarget.pipelineId) {
    return { action: 'skip', reason: 'already_in_target_status' }
  }

  const cliente = await getClienteReativacao(env, telefone)
  if (String(cliente?.atendimento_ia || '').toLowerCase() === 'pause') {
    return { action: 'skip', reason: 'ia_paused' }
  }
  const formStatus = String(cliente?.[FORM_STATUS_FIELD] || '').trim()
  if (formStatus && SKIP_INSCRICAO_STATUSES.has(formStatus)) {
    return { action: 'skip', reason: 'inscricao_flow_active', formStatus }
  }
  if (cliente?.[FIELD_MOVED_AT]) {
    return { action: 'skip', reason: 'already_moved' }
  }

  const rows = await fetchRecentChatRows(env, telefone, 40)
  if (!rows.length) return { action: 'skip', reason: 'no_history' }

  const pingAt = cliente?.[FIELD_PING_AT] || null
  const analysis = analyzeChatRows(rows, { sinceIso: pingAt })
  const now = Date.now()

  if (!analysis.hasAnyBot) {
    return { action: 'skip', reason: 'no_bot_message_yet' }
  }
  if (analysis.lastSpeaker === 'lead') {
    if (pingAt) {
      await setReativacaoFields(env, telefone, { [FIELD_PING_AT]: null }).catch(() => {})
    }
    return { action: 'skip', reason: 'lead_spoke_last' }
  }

  const msIdle = analysis.lastLeadAt != null ? now - analysis.lastLeadAt : Infinity
  const msSincePing = pingAt ? now - (parseTs(pingAt) || now) : 0

  // Fase 2: ping já enviado, sem resposta → mover funil
  if (pingAt && !analysis.leadRepliedAfterSince) {
    if (msSincePing < afterPingMs(env)) {
      return { action: 'skip', reason: 'waiting_after_ping', msSincePing }
    }
    const patch = await updateLeadPipelineStatus(env, leadId, moveTarget)
    if (patch.ok) {
      await setReativacaoFields(env, telefone, { [FIELD_MOVED_AT]: new Date().toISOString() })
      await createLeadNote(
        env,
        leadId,
        `Lead movido para fila ${moveTarget.statusId} após inatividade (sem resposta ao ping de reativação).`,
      ).catch(() => {})
      console.log(
        `[inactivity] lead=${leadId} movido pipeline=${moveTarget.pipelineId} status=${moveTarget.statusId}`,
      )
      return { action: 'moved', ok: true, statusId: moveTarget.statusId }
    }
    console.warn(`[inactivity] lead=${leadId} falha mover funil: ${patch.error}`)
    return { action: 'move_failed', error: patch.error }
  }

  // Fase 1: inativo ≥ N min → ping
  const fone = normalizeTelefone(telefone)
  const memPing = _pingMemory.get(fone)
  if (pingAt || (memPing && Date.now() - memPing < PING_MEMORY_TTL_MS)) {
    return { action: 'skip', reason: 'ping_already_sent' }
  }
  if (msIdle < idleMs(env)) {
    return { action: 'skip', reason: 'not_idle_yet', msIdle }
  }

  const claimed = await claimReativacaoPingExclusive(env, telefone)
  if (!claimed) {
    return { action: 'skip', reason: 'ping_claim_failed_or_already_sent' }
  }

  const text = pickPingMessage(leadId)
  const executionId = generateExecutionId()
  const sendRes = await sendMessageWithNote(env, {
    telefone: telefone || sessionId,
    text,
    leadId,
    executionId,
  })
  if (!sendRes?.ok) {
    await setReativacaoFields(env, telefone, { [FIELD_PING_AT]: null }).catch(() => {})
    console.warn(`[inactivity] lead=${leadId} falha enviar ping: ${sendRes?.error || sendRes?.code}`)
    return { action: 'ping_failed', error: sendRes?.error }
  }
  if (sendRes.deduped) {
    return { action: 'skip', reason: 'ping_deduped_outbound' }
  }

  const nowIso = new Date().toISOString()
  _pingMemory.set(fone, Date.now())
  await saveConversation(env, {
    telefone,
    userMessage: '',
    botMessage: text,
    messageType: 'reativacao_inatividade',
    idLead: leadId,
    createdAt: nowIso,
  }).catch(() => {})

  console.log(`[inactivity] lead=${leadId} ping reativacao enviado idle_min=${msIdle / 60000}`)
  return { action: 'ping_sent', text, executionId }
}
