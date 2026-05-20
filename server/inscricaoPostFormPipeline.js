/**
 * Pós Form Sumar:
 *   1) Formulário respondido → salesbot de distribuição (IA continua ativa)
 *   2) Distribuição concluída → valida campos no Kommo
 *   3) Campos OK → salesbot matrícula (49813) + pause IA
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  messageLooksLikeFormSumarResponse,
  buildInscricaoFormReceivedReply,
  buildInscricaoFormFieldsIncompleteReply,
  buildInscricaoFormCompleteReply,
} from '../libShared/inscricaoFormHeuristics.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { findLeadByPhone, listLeadNotes } from './kommoClient.js'
import { updateDadosCliente, getLeadIdByTelefone, normalizeTelefone } from './dadosClienteStore.js'
import { fetchLeadFormSnapshot, validateFormSnapshot } from './inscricaoKommoFields.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'
const FORM_RECEBIDO_AT_FIELD = 'inscricao_form_recebido_at'

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

async function setFormStatus(env, telefone, status, extra = {}) {
  const fields = { [FORM_STATUS_FIELD]: status, ...extra }
  const res = await updateDadosCliente(env, { telefone, fields })
  if (res.ok || !extra[FORM_RECEBIDO_AT_FIELD]) return res
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

function parseStatusIds(env, key) {
  return String(env[key] || '')
    .split(/[,;\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
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

/**
 * Distribuição concluída quando:
 * - lead está em status configurado (KOMMO_STATUS_APOS_DISTRIBUICAO_IDS), ou
 * - responsible_user_id atribuído (fora da lista de "não atribuído"), após tempo mínimo, ou
 * - nota recente indica encerramento do salesbot de distribuição.
 */
export async function isDistribuicaoConcluida(env, leadId, { formRecebidoAt } = {}) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) return { done: false, reason: 'invalid_lead' }

  const minWaitSec = Number(env.INSCRICAO_DISTRIBUICAO_MIN_WAIT_SEC || 20)
  if (formRecebidoAt) {
    const ts = Date.parse(formRecebidoAt)
    if (!Number.isNaN(ts) && Date.now() - ts < minWaitSec * 1000) {
      return { done: false, reason: 'aguardando_tempo_minimo' }
    }
  }

  const snap = await fetchLeadFormSnapshot(env, id)
  if (!snap.ok) return { done: false, reason: snap.error || 'lead_fetch_failed' }

  const statusIds = parseStatusIds(env, 'KOMMO_STATUS_APOS_DISTRIBUICAO_IDS')
  if (statusIds.length && statusIds.includes(snap.snapshot.status_id)) {
    return { done: true, reason: 'status_pos_distribuicao', snapshot: snap.snapshot }
  }

  let unassigned = parseStatusIds(env, 'KOMMO_DISTRIBUICAO_UNASSIGNED_USER_IDS')
  if (!unassigned.length) unassigned = [0]
  const responsible = snap.snapshot.responsible_user_id
  if (Number.isFinite(responsible) && responsible > 0 && !unassigned.includes(responsible)) {
    return { done: true, reason: 'responsible_user_atribuido', snapshot: snap.snapshot }
  }

  const botName = String(env.KOMMO_SALESBOT_DISTRIBUICAO_NAME || 'distribui').trim()
  const notesRes = await listLeadNotes(env, id, { limit: 25, order: 'desc' })
  if (notesRes.ok && Array.isArray(notesRes.notes)) {
    for (const n of notesRes.notes) {
      const text = String(n?.params?.text || n?.text || '').toLowerCase()
      if (!text) continue
      if (/\b(distribui|consultor\s+designado|encaminhado\s+para|atribu[ií]do\s+ao)\b/i.test(text)) {
        return { done: true, reason: 'nota_distribuicao', snapshot: snap.snapshot }
      }
      if (botName && new RegExp(`${botName}.*encerrad`, 'i').test(text)) {
        return { done: true, reason: 'salesbot_distrib_encerrado', snapshot: snap.snapshot }
      }
    }
  }

  return { done: false, reason: 'aguardando_distribuicao', snapshot: snap.snapshot }
}

async function stepFormRecebido(env, ctx) {
  const { telefone, idLead, executionId, pushName, t0 } = ctx
  const salesbotRes = await runKommoSalesbot(env, idLead, 'distribuicao_pos_form', {
    executionId,
    note: `Form Sumar recebido — salesbot distribuição disparado (agente IA) — ${executionId || ''}`.trim(),
  })
  const distribOk = Boolean(salesbotRes.ok && !salesbotRes.skipped)
  const nowIso = new Date().toISOString()

  await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO, {
    [FORM_RECEBIDO_AT_FIELD]: nowIso,
  })

  return {
    handled: true,
    result: buildAgentReturn({
      executionId: ctx.executionId,
      model: ctx.model,
      t0,
      reply: buildInscricaoFormReceivedReply({ pushName }),
      steps: [
        {
          type: 'inscricao_form_recebido',
          distrib_ok: distribOk,
          bot_id: salesbotRes.botId,
        },
        { type: 'inscricao_form_status', value: INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO },
      ],
      toolCalls: [
        {
          tool: 'distribuicao_pos_form_salesbot',
          args: { telefone, id_lead: idLead },
          result: distribOk ? `Salesbot distribuição ${salesbotRes.botId}` : salesbotRes.text || 'falha',
          ok: distribOk,
        },
      ],
      ctxSnapshot: {
        inscricaoForm: 'aguardando_distribuicao',
        distribSalesbotId: salesbotRes.botId,
        iaPaused: false,
      },
    }),
  }
}

async function stepValidarEMatricula(env, ctx) {
  const { telefone, idLead, executionId, pushName, t0, schedulerTick } = ctx
  const row = await getClienteRow(env, telefone)
  const formRecebidoAt = row?.[FORM_RECEBIDO_AT_FIELD] || null

  const distrib = await isDistribuicaoConcluida(env, idLead, { formRecebidoAt })
  if (!distrib.done) {
    if (schedulerTick) return { handled: false }
    return { handled: false, reason: distrib.reason }
  }

  const leadSnap = await fetchLeadFormSnapshot(env, idLead)
  if (!leadSnap.ok) {
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model: ctx.model,
        t0,
        ok: false,
        reply:
          'Recebemos seu formulário! Estamos validando seus dados no cadastro — em instantes um consultor da Faculdade Sumaré segue com você.',
        steps: [{ type: 'inscricao_validacao', ok: false, code: leadSnap.error }],
      }),
    }
  }

  const validation = validateFormSnapshot(env, leadSnap.snapshot)
  if (!validation.valid) {
    await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO, {
      inscricao_form_campos_pendentes: validation.missingFields.join('; '),
    })
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model: ctx.model,
        t0,
        reply: buildInscricaoFormFieldsIncompleteReply({
          pushName,
          missingFields: validation.missingFields,
        }),
        steps: [
          {
            type: 'inscricao_validacao_campos',
            ok: false,
            missing: validation.missingFields,
          },
        ],
        ctxSnapshot: { inscricaoForm: 'campos_incompletos', missing: validation.missingFields },
      }),
    }
  }

  const [salesbotRes, pauseRes] = await Promise.all([
    runKommoSalesbot(env, idLead, 'matricula_pos_form', {
      executionId,
      note: `Form validado — salesbot matrícula ${env.KOMMO_SALESBOT_MATRICULA_POS_FORM_ID || '49813'} (agente IA)`.trim(),
    }),
    pauseAtendimentoIa(env, telefone),
  ])
  await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_CONCLUIDO, {
    inscricao_form_campos_pendentes: null,
  })

  const matriculaOk = Boolean(salesbotRes.ok && !salesbotRes.skipped)
  const reply = buildInscricaoFormCompleteReply({ pushName, ok: matriculaOk })

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model: ctx.model,
      t0,
      reply,
      steps: [
        {
          type: 'inscricao_form_validado',
          ok: true,
          campos: validation.required,
        },
        {
          type: 'inscricao_matricula_salesbot',
          ok: matriculaOk,
          bot_id: salesbotRes.botId,
          pause_ok: pauseRes.ok,
        },
      ],
      toolCalls: [
        {
          tool: 'matricula_pos_form',
          args: { telefone, id_lead: idLead },
          result: matriculaOk ? `Salesbot ${salesbotRes.botId}` : salesbotRes.text || 'falha',
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
 * Pipeline unificado pós-formulário.
 * @param {boolean} [input.schedulerTick] — tick do scheduler sem mensagem nova
 */
export async function tryProcessInscricaoPostFormPipeline(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0, schedulerTick } = input
  if (!telefone) return null

  const row = await getClienteRow(env, telefone)
  const status = row?.[FORM_STATUS_FIELD] ?? null
  const looksLikeForm = messageLooksLikeFormSumarResponse(userMessage)

  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO) return null

  const idLead = await resolveLeadId(env, telefone, leadIdHint)
  if (idLead == null && (looksLikeForm || status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO)) {
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
        steps: [{ type: 'inscricao_post_form', ok: false, code: 'LEAD_NOT_FOUND' }],
      }),
    }
  }
  if (idLead == null) return null

  const ctx = { telefone, idLead, executionId, model, pushName, t0, schedulerTick }

  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO) {
    const advanced = await stepValidarEMatricula(env, ctx)
    if (advanced.handled) return advanced
    return null
  }

  if (looksLikeForm || status === INSCRICAO_FORM_STATUS_AGUARDANDO) {
    if (!looksLikeForm) return null
    if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO) {
      return stepValidarEMatricula(env, ctx)
    }
    return stepFormRecebido(env, ctx)
  }

  return null
}

/** Compat: agentRunner import antigo. */
export async function tryHandleInscricaoFormComplete(env, input) {
  return tryProcessInscricaoPostFormPipeline(env, input)
}

/** Scheduler: tenta avançar validação + 49813 sem mensagem do lead. */
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
