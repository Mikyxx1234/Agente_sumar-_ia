/**
 * Fluxo inscrição Sumaré: template Form Sumar → preenchimento → salesbot 49815.
 * Substitui o disparo direto do salesbot 49813 (descontinuado).
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  messageRequestsInscricaoForm,
  messageAsksForFormResend,
  messageLooksLikeFormSumarResponse,
  buildInscricaoFormSentReply,
  buildInscricaoFormCompleteReply,
} from '../libShared/inscricaoFormHeuristics.js'
import { messageLooksLikeOperationalChat } from '../libShared/scopeHeuristics.js'
import { sendFormSumarTemplate } from './whatsappTemplateSender.js'
import { sendMessageWithNote } from './whatsappSender.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { findLeadByPhone } from './kommoClient.js'
import { updateDadosCliente, getLeadIdByTelefone, normalizeTelefone } from './dadosClienteStore.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

async function getFormStatus(env, telefone) {
  const { url, key } = getSupabaseCfg(env)
  if (!url || !key) return null
  const fone = normalizeTelefone(telefone)
  if (!fone) return null
  try {
    const enc = encodeURIComponent(fone)
    const res = await fetch(`${url}/rest/v1/dados_cliente?telefone=eq.${enc}&select=${FORM_STATUS_FIELD}&limit=1`, {
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
  const { url, key } = getSupabaseCfg(env)
  if (!url || !key) return { ok: false }
  try {
    const enc = encodeURIComponent(normalizeTelefone(telefone))
    const res = await fetch(`${url}/rest/v1/dados_cliente?telefone=eq.${enc}`, {
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

/**
 * Lead pediu inscrição → envia template Form Sumar (sem salesbot 49813).
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
      'Já enviei o formulário Form Sumar por aqui. Quando terminar de preencher e enviar, nossa equipe segue com você automaticamente. Precisa de ajuda com algum campo?'
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
  const templateRes = await sendFormSumarTemplate(env, {
    to: telefone,
    leadId: idLead,
    executionId,
  })

  const statusUpdate = await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO)
  const reply = buildInscricaoFormSentReply({ pushName })

  let whatsappReply = reply
  if (asksResend && templateRes.ok) {
    whatsappReply =
      'Acabei de reenviar o formulário Form Sumar aqui no WhatsApp. Confira a mensagem com o botão "Formulário" e preencha quando puder, tudo bem?'
  }
  if (!templateRes.ok) {
    console.error(
      `[inscricaoForm] FALHA template telefone=${telefone} templates=${templateRes.template} status=${templateRes.status} err=${templateRes.error}`,
    )
    whatsappReply =
      'Queremos muito te ajudar com a inscrição na Faculdade Sumaré! No momento não consegui abrir o formulário automático no WhatsApp — um consultor entrará em contato em breve por aqui.'
    await sendMessageWithNote(env, {
      telefone,
      text: whatsappReply,
      leadId: idLead,
      executionId,
    }).catch((e) => console.warn(`[inscricaoForm] sendMessageWithNote fallback: ${e.message}`))
  }

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply: whatsappReply,
      steps: [
        { type: 'inscricao_form_template', ok: templateRes.ok, template: templateRes.template, status: templateRes.status },
        { type: 'inscricao_form_status', ok: statusUpdate.ok, value: INSCRICAO_FORM_STATUS_AGUARDANDO },
      ],
      toolCalls: [
        {
          tool: 'form_sumar_template',
          args: { telefone, template: templateRes.template },
          result: templateRes.ok ? 'Template enviado' : templateRes.error,
          ok: templateRes.ok,
        },
      ],
      ctxSnapshot: { inscricaoForm: 'template_sent', historyConsidered: historyMessages?.length || 0 },
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

/**
 * Se o orquestrador prometeu o formulário mas o envio automático não rodou antes, envia agora.
 */
export async function tryEnsureInscricaoFormSent(env, input) {
  const { telefone, userMessage, historyMessages, llmReply } = input
  if (!telefone) return null

  const llmPromisedForm =
    llmReply &&
    /\bformul[aá]rio\b/i.test(llmReply) &&
    /\b(enviad|enviar|mandar|whatsapp|instantes)\b/i.test(llmReply)
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

/** Tool/API: início do fluxo (template). */
export async function runInscricaoFormStart(env, body) {
  const telefone = body?.telefone
  if (!telefone) return { ok: false, code: 'MISSING_TELEFONE' }
  const idLead = await resolveLeadId(env, telefone, body?.id_lead ?? body?.idLead)
  const templateRes = await sendFormSumarTemplate(env, { to: telefone, leadId: idLead })
  const statusUpdate = await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO)
  return {
    ok: templateRes.ok,
    template: templateRes,
    statusUpdate,
    message: templateRes.ok ? 'Template Form Sumar enviado.' : templateRes.error,
  }
}
