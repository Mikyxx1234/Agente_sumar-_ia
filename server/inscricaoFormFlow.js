/**
 * Fluxo inscrição Sumaré:
 *   início → salesbot Kommo "Formulario_Sum" (envia o formulário no WhatsApp)
 *   pós preenchimento → salesbot 49813 (matrícula) + pause IA
 *   (ver server/inscricaoPostFormPipeline.js)
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  messageConfirmsProceedToInscricaoForm,
  messageExpressesCourseInterestOnly,
  messageAsksForFormResend,
  messageIsCourseCatalogRequest,
  messageLooksLikeFormSumarResponse,
  messageLooksLikeFormFollowUp,
  buildInscricaoFormSentReply,
  lastAssistantText,
  assistantInEnrollmentStep,
} from '../libShared/inscricaoFormHeuristics.js'
import { messageLooksLikeOperationalChat } from '../libShared/scopeHeuristics.js'
import { sendFormSumarTemplate } from './whatsappTemplateSender.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { findLeadByPhone } from './kommoClient.js'
import {
  updateDadosCliente,
  getLeadIdByTelefone,
  normalizeTelefone,
  fetchDadosClienteByTelefone,
  dadosClienteTelefoneOrFilter,
} from './dadosClienteStore.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

function useWhatsappTemplateDelivery(env) {
  const mode = String(env.INSCRICAO_FORM_DELIVERY || 'kommo_salesbot').trim().toLowerCase()
  return mode === 'whatsapp_template' || mode === 'meta_template' || mode === 'template'
}

async function getFormStatus(env, telefone) {
  const row = await fetchDadosClienteByTelefone(env, telefone, FORM_STATUS_FIELD)
  return row?.[FORM_STATUS_FIELD] ?? null
}

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum',
  }
}

async function setFormStatus(env, telefone, status) {
  return updateDadosCliente(env, {
    telefone,
    fields: { [FORM_STATUS_FIELD]: status },
  })
}

/**
 * Claim atômico no Supabase: só um processo/réplica dispara o Formulario_Sum.
 * PATCH só quando inscricao_form_status ainda é null.
 */
async function releaseInscricaoFormStartClaim(env, telefone) {
  return updateDadosCliente(env, {
    telefone,
    fields: { [FORM_STATUS_FIELD]: null },
  })
}

async function claimInscricaoFormStartExclusive(env, telefone) {
  const { url, key, table } = getSupabaseCfg(env)
  if (!url || !key) return { claimed: false, reason: 'no_supabase' }
  const telFilter = dadosClienteTelefoneOrFilter(telefone)
  if (!telFilter) return { claimed: false, reason: 'invalid_phone' }
  try {
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?${telFilter}&${FORM_STATUS_FIELD}=is.null`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_AGUARDANDO }),
      },
    )
    if (!res.ok) return { claimed: false, reason: `patch_${res.status}` }
    const rows = await res.json()
    if (Array.isArray(rows) && rows.length > 0) {
      return { claimed: true, reason: 'claimed_null_status' }
    }
    const status = await getFormStatus(env, telefone)
    return { claimed: false, reason: 'already_started', status }
  } catch (err) {
    return { claimed: false, reason: `claim_error_${err.message}` }
  }
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
async function deliverInscricaoForm(env, { telefone, leadId, executionId, forceResend = false }) {
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
    force: forceResend,
    note: `Salesbot Formulario_Sum ativado (inscrição via agente IA) — ${executionId || ''}`.trim(),
  })
  return {
    delivery: 'kommo_salesbot',
    result: {
      ok: Boolean(salesbotRes.ok && !salesbotRes.skipped),
      skipped: Boolean(salesbotRes.skipped),
      reason: salesbotRes.reason,
      code: salesbotRes.code || (salesbotRes.ok ? 'SALESBOT_STARTED' : 'SALESBOT_FAILED'),
      botId: salesbotRes.botId,
      status: salesbotRes.status,
      error: salesbotRes.error || salesbotRes.reason || salesbotRes.text,
    },
  }
}

/**
 * Lead pediu inscrição → ativa salesbot Formulario_Sum (formulário no WhatsApp).
 */
export async function tryHandleInscricaoFormStart(env, input) {
  const { telefone, userMessage, historyMessages, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  const wantsForm = messageConfirmsProceedToInscricaoForm(userMessage, historyMessages)
  const asksResend = messageAsksForFormResend(userMessage)
  if (!telefone || (!wantsForm && !asksResend)) return null
  if (messageLooksLikeOperationalChat(userMessage) && !asksResend) return null

  const status = await getFormStatus(env, telefone)
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO) {
    return null
  }
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO && !asksResend && !wantsForm) {
    if (
      messageExpressesCourseInterestOnly(userMessage, historyMessages) ||
      messageIsCourseCatalogRequest(userMessage)
    ) {
      return null
    }
    if (messageLooksLikeFormFollowUp(userMessage) || messageAsksForFormResend(userMessage)) {
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
    return null
  }

  const idLead = await resolveLeadId(env, telefone, leadIdHint)

  if (!asksResend) {
    const claim = await claimInscricaoFormStartExclusive(env, telefone)
    if (!claim.claimed) {
      const st = claim.status ?? (await getFormStatus(env, telefone))
      if (st === INSCRICAO_FORM_STATUS_AGUARDANDO) {
        const reply =
          'Já ativei o envio do formulário de inscrição por aqui. Quando terminar de preencher e enviar, nossa equipe segue com você automaticamente. Precisa de ajuda com algum campo?'
        return {
          handled: true,
          result: buildAgentReturn({
            executionId,
            model,
            t0,
            reply,
            steps: [{ type: 'inscricao_form_reminder', status: st, claim: claim.reason }],
            ctxSnapshot: { inscricaoForm: 'aguardando' },
          }),
        }
      }
      if (st === INSCRICAO_FORM_STATUS_CONCLUIDO) return null
    }
  }

  const delivery = await deliverInscricaoForm(env, {
    telefone,
    leadId: idLead,
    executionId,
    forceResend: asksResend,
  })
  const dedupeSkipped = Boolean(
    delivery.result?.skipped && delivery.delivery === 'kommo_salesbot',
  )
  const sendOk = Boolean(delivery.result?.ok)

  let statusUpdate = { ok: false, skipped: true }
  if (sendOk && asksResend) {
    statusUpdate = await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO)
  } else if (sendOk) {
    statusUpdate = { ok: true, skipped: false, matched: true }
  }

  if (dedupeSkipped && !asksResend) {
    const reply =
      'Já ativei o envio do formulário de inscrição por aqui. Quando terminar de preencher e enviar, nossa equipe segue com você automaticamente. Precisa de ajuda com algum campo?'
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'inscricao_form_reminder', status: 'dedupe_salesbot' }],
        ctxSnapshot: { inscricaoForm: 'aguardando' },
      }),
    }
  }

  if (!sendOk && !asksResend) {
    await releaseInscricaoFormStartClaim(env, telefone).catch(() => {})
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

export { tryHandleInscricaoFormComplete } from './inscricaoPostFormPipeline.js'

export async function tryEnsureInscricaoFormSent(env, input) {
  const { telefone, userMessage, historyMessages, llmReply } = input
  if (!telefone) return null
  if (messageIsCourseCatalogRequest(userMessage)) return null

  const userConfirmed = messageConfirmsProceedToInscricaoForm(userMessage, historyMessages)
  const lastAssist = lastAssistantText(historyMessages)
  const llmPromisedForm =
    llmReply &&
    /\bformul[aá]rio\b/i.test(llmReply) &&
    /\b(enviad|enviar|mandar|enviando|whatsapp|instantes|ativar|preencher)\b/i.test(llmReply) &&
    (userConfirmed || assistantInEnrollmentStep(lastAssist))
  const should = userConfirmed || messageAsksForFormResend(userMessage) || llmPromisedForm
  if (!should) return null

  const status = await getFormStatus(env, telefone)
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO) return null
  if (
    status === INSCRICAO_FORM_STATUS_AGUARDANDO &&
    !messageAsksForFormResend(userMessage) &&
    !userConfirmed
  ) {
    return null
  }

  return tryHandleInscricaoFormStart(env, input)
}

/** Tool/API: início do fluxo (salesbot Formulario_Sum por padrão). */
export async function runInscricaoFormStart(env, body) {
  const telefone = body?.telefone
  if (!telefone) return { ok: false, code: 'MISSING_TELEFONE' }
  const forceResend = Boolean(body?.force || body?.resend)
  if (!forceResend) {
    const claim = await claimInscricaoFormStartExclusive(env, telefone)
    if (!claim.claimed) {
      const st = claim.status ?? (await getFormStatus(env, telefone))
      if (st === INSCRICAO_FORM_STATUS_AGUARDANDO || st === INSCRICAO_FORM_STATUS_CONCLUIDO) {
        return {
          ok: true,
          skipped: true,
          code: 'FORM_ALREADY_STARTED',
          message: 'Formulário já foi ativado para este lead.',
          status: st,
        }
      }
    }
  }
  const idLead = await resolveLeadId(env, telefone, body?.id_lead ?? body?.idLead)
  const delivery = await deliverInscricaoForm(env, { telefone, leadId: idLead, forceResend })
  const sendOk = Boolean(delivery.result?.ok)
  const statusUpdate =
    sendOk && forceResend
      ? await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO)
      : sendOk
        ? { ok: true, skipped: false }
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
