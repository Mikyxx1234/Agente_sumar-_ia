/**
 * Fluxo inscrição Sumaré:
 *   início → salesbot Kommo "Formulario_Sum" (envia o formulário no WhatsApp)
 *   pós preenchimento → salesbot 49815 + pause IA
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  messageRequestsInscricaoForm,
  messageAsksForFormResend,
  messageIsCourseCatalogRequest,
  messageLooksLikeFormSumarResponse,
  buildInscricaoFormSentReply,
  buildInscricaoFormCompleteReply,
} from '../libShared/inscricaoFormHeuristics.js'
import { messageLooksLikeOperationalChat } from '../libShared/scopeHeuristics.js'
import { sendFormSumarTemplate } from './whatsappTemplateSender.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { findLeadByPhone } from './kommoClient.js'
import { updateDadosCliente, getLeadIdByTelefone, normalizeTelefone } from './dadosClienteStore.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

function useWhatsappTemplateDelivery(env) {
  const mode = String(env.INSCRICAO_FORM_DELIVERY || 'kommo_salesbot').trim().toLowerCase()
  return mode === 'whatsapp_template' || mode === 'meta_template' || mode === 'template'
}

async function getFormStatus(env, telefone) {
  const { url, key, table } = getSupabaseCfg(env)
  if (!url || !key) return null
  const fone = normalizeTelefone(telefone)
  if (!fone) return null
  try {
    const enc = encodeURIComponent(fone)
    const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?telefone=eq.${enc}&select=${FORM_STATUS_FIELD}&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    if (!res.ok) return null
    const rows = await res.json()
    return rows?.[0]?.[FORM_STATUS_FIELD] ?? null
  } catch {
    return null
  }
}

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente',
  }
}

async function setFormStatus(env, telefone, status) {
  return updateDadosCliente(env, {
    telefone,
    fields: { [FORM_STATUS_FIELD]: status },
  })
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
  const { url, key, table } = getSupabaseCfg(env)
  if (!url || !key) return { ok: false }
  try {
    const enc = encodeURIComponent(normalizeTelefone(telefone))
    const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?telefone=eq.${enc}`, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ atendimento_ia: 'pause' }),
    })
    return { ok: res.ok }
  } catch {
    return { ok: false }
  }
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

/** Dispara salesbot Formulario_Sum ou template Meta (fallback legado). */
async function deliverInscricaoForm(env, { telefone, leadId, executionId }) {
  if (useWhatsappTemplateDelivery(env)) {
    return {
      delivery: 'whatsapp_template',
      result: await sendFormSumarTemplate(env, { to: telefone, leadId, executionId }),
    }
  }

  if (leadId == null) {
    return {
      delivery: 'kommo_salesbot',
      result: {
        ok: false,
        code: 'LEAD_NOT_FOUND',
        error: 'Lead não localizado no Kommo — necessário para ativar o salesbot Formulario_Sum.',
      },
    }
  }

  const salesbotRes = await runKommoSalesbot(env, leadId, 'formulario_sum', {
    executionId,
    note: `Salesbot Formulario_Sum ativado (inscrição via agente IA) — ${executionId || ''}`.trim(),
  })
  return {
    delivery: 'kommo_salesbot',
    result: {
      ok: Boolean(salesbotRes.ok && !salesbotRes.skipped),
      code: salesbotRes.code || (salesbotRes.ok ? 'SALESBOT_STARTED' : 'SALESBOT_FAILED'),
      botId: salesbotRes.botId,
      status: salesbotRes.status,
      error: salesbotRes.error || salesbotRes.reason || salesbotRes.text,
      skipped: salesbotRes.skipped,
    },
  }
}

/**
 * Lead pediu inscrição → ativa salesbot Formulario_Sum (formulário no WhatsApp).
 */
export async function tryHandleInscricaoFormStart(env, input) {
  const { telefone, userMessage, historyMessages, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  const wantsForm = messageRequestsInscricaoForm(userMessage, historyMessages)
  const asksResend = messageAsksForFormResend(userMessage)
  if (!telefone || (!wantsForm && !asksResend)) return null
  if (messageLooksLikeOperationalChat(userMessage) && !asksResend) return null

  const status = await getFormStatus(env, telefone)
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO) {
    return null
  }
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO && !asksResend) {
    const reply =
      'Já ativei o envio do formulário de inscrição por aqui. Quando terminar de preencher e enviar, nossa equipe segue com você automaticamente. Precisa de ajuda com algum campo?'
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'inscricao_form_reminder', status }],
        ctxSnapshot: { inscricaoForm: 'aguardando' },
      }),
    }
  }

  const idLead = await resolveLeadId(env, telefone, leadIdHint)
  const delivery = await deliverInscricaoForm(env, {
    telefone,
    leadId: idLead,
    executionId,
  })
  const sendOk = Boolean(delivery.result?.ok)

  let statusUpdate = { ok: false, skipped: true }
  if (sendOk) {
    statusUpdate = await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO)
  }

  let whatsappReply = buildInscricaoFormSentReply({ pushName, resend: asksResend })
  if (!sendOk) {
    console.error(
      `[inscricaoForm] FALHA delivery=${delivery.delivery} telefone=${telefone} lead=${idLead ?? 'n/a'} err=${delivery.result?.error || delivery.result?.code}`,
    )
    if (delivery.result?.code === 'MISSING_FORMULARIO_SUM_BOT_ID') {
      whatsappReply =
        'Queremos muito te ajudar com a inscrição! No momento o formulário automático não está configurado no sistema — um consultor entrará em contato em breve por aqui.'
    } else if (delivery.result?.code === 'LEAD_NOT_FOUND') {
      whatsappReply =
        'Perfeito! Para enviar o formulário de inscrição, preciso localizar seu cadastro — em instantes um consultor da Faculdade Sumaré fala com você por aqui, tudo bem?'
    } else {
      whatsappReply =
        'Queremos muito te ajudar com a inscrição na Faculdade Sumaré! No momento não consegui abrir o formulário automático no WhatsApp — um consultor entrará em contato em breve por aqui.'
    }
  }

  const toolName = delivery.delivery === 'kommo_salesbot' ? 'formulario_sum_salesbot' : 'form_sumar_template'

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply: whatsappReply,
      steps: [
        {
          type: 'inscricao_form_start',
          delivery: delivery.delivery,
          ok: sendOk,
          bot_id: delivery.result?.botId,
          template: delivery.result?.template,
          status: delivery.result?.status,
        },
        { type: 'inscricao_form_status', ok: statusUpdate.ok, value: sendOk ? INSCRICAO_FORM_STATUS_AGUARDANDO : null },
      ],
      toolCalls: [
        {
          tool: toolName,
          args: { telefone, id_lead: idLead, delivery: delivery.delivery },
          result: sendOk ? 'Formulário disparado' : delivery.result?.error || delivery.result?.code,
          ok: sendOk,
        },
      ],
      ctxSnapshot: {
        inscricaoForm: sendOk ? 'form_started' : 'form_start_failed',
        delivery: delivery.delivery,
        salesbotId: delivery.result?.botId,
      },
    }),
  }
}

/**
 * Formulário preenchido → salesbot 49815 + pause IA.
 */
export async function tryHandleInscricaoFormComplete(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  if (!telefone) return null

  const status = await getFormStatus(env, telefone)
  const looksLikeForm = messageLooksLikeFormSumarResponse(userMessage)
  if (!looksLikeForm && status !== INSCRICAO_FORM_STATUS_AGUARDANDO) return null
  if (!looksLikeForm) return null

  const idLead = await resolveLeadId(env, telefone, leadIdHint)
  if (idLead == null) {
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

  const [salesbotRes, pauseRes] = await Promise.all([
    runKommoSalesbot(env, idLead, 'matricula_pos_form'),
    pauseAtendimentoIa(env, telefone),
  ])
  await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_CONCLUIDO)

  const handoffOk = Boolean(salesbotRes.ok && !salesbotRes.skipped)
  const reply = buildInscricaoFormCompleteReply({ pushName, ok: handoffOk })

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
          ok: handoffOk,
          salesbot_ok: salesbotRes.ok,
          bot_id: salesbotRes.botId,
          pause_ok: pauseRes.ok,
        },
      ],
      toolCalls: [
        {
          tool: 'matricula_pos_form',
          args: { telefone, id_lead: idLead },
          result: handoffOk ? `Salesbot ${salesbotRes.botId} disparado` : salesbotRes.text || 'falha',
          ok: handoffOk,
        },
      ],
      ctxSnapshot: { inscricaoForm: 'completed', salesbotId: salesbotRes.botId },
    }),
  }
}

export async function tryEnsureInscricaoFormSent(env, input) {
  const { telefone, userMessage, historyMessages, llmReply } = input
  if (!telefone) return null
  if (messageIsCourseCatalogRequest(userMessage)) return null

  const llmPromisedForm =
    llmReply &&
    /\bformul[aá]rio\b/i.test(llmReply) &&
    /\b(enviad|enviar|mandar|whatsapp|instantes|ativar)\b/i.test(llmReply)
  const should =
    messageRequestsInscricaoForm(userMessage, historyMessages) ||
    messageAsksForFormResend(userMessage) ||
    llmPromisedForm
  if (!should) return null

  const status = await getFormStatus(env, telefone)
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO) return null
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO && !messageAsksForFormResend(userMessage)) {
    return null
  }

  return tryHandleInscricaoFormStart(env, input)
}

/** Tool/API: início do fluxo (salesbot Formulario_Sum por padrão). */
export async function runInscricaoFormStart(env, body) {
  const telefone = body?.telefone
  if (!telefone) return { ok: false, code: 'MISSING_TELEFONE' }
  const idLead = await resolveLeadId(env, telefone, body?.id_lead ?? body?.idLead)
  const delivery = await deliverInscricaoForm(env, { telefone, leadId: idLead })
  const sendOk = Boolean(delivery.result?.ok)
  const statusUpdate = sendOk
    ? await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO)
    : { ok: false, skipped: true }
  return {
    ok: sendOk,
    delivery: delivery.delivery,
    result: delivery.result,
    statusUpdate,
    message: sendOk
      ? 'Salesbot Formulario_Sum ativado (formulário enviado pelo Kommo).'
      : delivery.result?.error || delivery.result?.code,
  }
}
