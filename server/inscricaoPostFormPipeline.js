/**
 * Pós Form Sumar (fluxo direto):
 *   formulário respondido → salesbot matrícula 49813 + pause IA
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  messageLooksLikeFormSumarResponse,
  messageLooksLikeFormFollowUp,
  buildInscricaoFormCompleteReply,
} from '../libShared/inscricaoFormHeuristics.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { findLeadByPhone } from './kommoClient.js'
import { updateDadosCliente, getLeadIdByTelefone, normalizeTelefone } from './dadosClienteStore.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'
const MATRICULA_BOT_ID_DEFAULT = 49813

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente',
  }
}

async function getClienteRow(env, telefone) {
  const { url, key, table } = getSupabaseCfg(env)
  if (!url || !key) return null
  const fone = normalizeTelefone(telefone)
  if (!fone) return null
  try {
    const enc = encodeURIComponent(fone)
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?telefone=eq.${enc}&select=${FORM_STATUS_FIELD},id_lead&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    )
    if (!res.ok) return null
    const rows = await res.json()
    return rows?.[0] || null
  } catch {
    return null
  }
}

async function setFormStatus(env, telefone, status) {
  return updateDadosCliente(env, { telefone, fields: { [FORM_STATUS_FIELD]: status } })
}

async function resolveLeadId(env, telefone, leadIdHint) {
  if (Number.isFinite(leadIdHint) && leadIdHint > 0) return leadIdHint
  const fromDb = await getLeadIdByTelefone(env, telefone)
  if (fromDb != null) return Number(fromDb) || fromDb
  try {
    const lookup = await findLeadByPhone(env, telefone)
    if (lookup.ok && lookup.lead?.id) return Number(lookup.lead.id)
  } catch {
    /* ignore */
  }
  return null
}

async function pauseAtendimentoIa(env, telefone) {
  return updateDadosCliente(env, { telefone, fields: { atendimento_ia: 'pause' } })
}

function buildAgentReturn({ executionId, model, t0, reply, steps, toolCalls, ctxSnapshot, ok = true }) {
  return {
    ok,
    reply,
    toolCalls: toolCalls || [],
    orchestratorSteps: steps || [],
    ctxSnapshot: ctxSnapshot || {},
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    durationMs: Date.now() - t0,
    executionId,
    model,
    inscricaoFormHandled: true,
  }
}

function shouldTriggerMatriculaPosForm(userMessage, status) {
  if (messageLooksLikeFormSumarResponse(userMessage)) return true
  if (
    status === INSCRICAO_FORM_STATUS_AGUARDANDO ||
    status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO
  ) {
    return messageLooksLikeFormFollowUp(userMessage)
  }
  return false
}

/**
 * Form preenchido → salesbot 49813 (matricula_pos_form) + pause IA.
 */
async function stepMatriculaPosForm(env, ctx) {
  const { telefone, idLead, executionId, model, pushName, t0 } = ctx

  const [salesbotRes, pauseRes] = await Promise.all([
    runKommoSalesbot(env, idLead, 'matricula_pos_form', {
      executionId,
      note: `Form Sumar recebido — salesbot matrícula ${MATRICULA_BOT_ID_DEFAULT} (agente IA) — ${executionId || ''}`.trim(),
    }),
    pauseAtendimentoIa(env, telefone),
  ])
  await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_CONCLUIDO)

  const matriculaOk = Boolean(salesbotRes.ok && !salesbotRes.skipped)
  const reply = buildInscricaoFormCompleteReply({ pushName, ok: matriculaOk })

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps: [
        {
          type: 'inscricao_form_complete',
          ok: matriculaOk,
          bot_id: salesbotRes.botId,
          pause_ok: pauseRes.ok,
        },
      ],
      toolCalls: [
        {
          tool: 'matricula_pos_form',
          args: { telefone, id_lead: idLead },
          result: matriculaOk ? `Salesbot ${salesbotRes.botId} disparado` : salesbotRes.text || 'falha',
          ok: matriculaOk,
        },
      ],
      ctxSnapshot: {
        inscricaoForm: 'completed',
        salesbotId: salesbotRes.botId,
        iaPaused: true,
      },
    }),
  }
}

/**
 * Pipeline pós-formulário: dispara 49813 assim que o formulário é detectado.
 * @param {boolean} [input.schedulerTick] — tick do scheduler (leads presos em aguardando_distribuicao)
 */
export async function tryProcessInscricaoPostFormPipeline(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0, schedulerTick } = input
  if (!telefone) return null

  const row = await getClienteRow(env, telefone)
  const status = row?.[FORM_STATUS_FIELD] ?? null

  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO) return null

  const trigger =
    shouldTriggerMatriculaPosForm(userMessage, status) ||
    (schedulerTick && status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO)

  if (!trigger) return null

  const idLead = await resolveLeadId(env, telefone, leadIdHint)
  if (idLead == null) {
    if (schedulerTick) return { handled: false }
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        ok: false,
        reply:
          'Recebi seu formulário! Para seguir, preciso localizar seu cadastro — em instantes um consultor da Faculdade Sumaré fala com você.',
        steps: [{ type: 'inscricao_form_complete', ok: false, code: 'LEAD_NOT_FOUND' }],
      }),
    }
  }

  return stepMatriculaPosForm(env, { telefone, idLead, executionId, model, pushName, t0 })
}

/** Compat: agentRunner import antigo. */
export async function tryHandleInscricaoFormComplete(env, input) {
  return tryProcessInscricaoPostFormPipeline(env, input)
}

/** Scheduler: leads presos em aguardando_distribuicao (fluxo antigo) → dispara 49813. */
export async function tryAdvanceInscricaoPostFormScheduler(env, { telefone, leadId }) {
  return tryProcessInscricaoPostFormPipeline(env, {
    telefone,
    leadId,
    userMessage: '',
    executionId: `sched-insc-${Date.now()}`,
    model: 'scheduler',
    t0: Date.now(),
    schedulerTick: true,
  })
}
