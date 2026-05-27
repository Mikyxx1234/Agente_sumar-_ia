/**
 * Escolha de polo Sumaré:
 *   - ANTES do Form Sumar (fluxo principal)
 *   - PÓS-formulário (legado aguardando_escolha_polo)
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  buildInscricaoFormSentReply,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  matchPoloFromUserMessage,
  resolvePoloUnidadeCode,
  buildPoloConfirmacaoInvalidaReply,
  buildPoloEscolhidoAckReply,
  buildPoloOutroLocalidadeReply,
  messageMentionsUnlistedPoloLocation,
  assistantAskedPoloPreFormChoice,
} from '../libShared/sumarePoloCatalog.js'
import { lastAssistantText } from '../libShared/inscricaoFormHeuristics.js'
import { filterHistoryMessagesForAgent } from '../libShared/historySanitize.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import {
  updateDadosCliente,
  ensureDadosClienteRow,
  fetchDadosClienteByTelefone,
  getLeadIdByTelefone,
} from './dadosClienteStore.js'
import { DADOS_CLIENTE_INSCRICAO_SELECT } from './dadosClienteInscricaoFields.js'
import { executeCaptacaoAfterFormResolved } from './inscricaoPostFormPipeline.js'
import { deliverInscricaoForm } from './inscricaoFormFlow.js'
import { listLeadNotes } from './kommoClient.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

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

async function resolveLeadId(env, telefone, leadIdHint) {
  if (Number.isFinite(leadIdHint) && leadIdHint > 0) return leadIdHint
  const fromDb = await getLeadIdByTelefone(env, telefone)
  if (fromDb != null) return Number(fromDb) || fromDb
  return null
}

/**
 * Fallback (Fix 2): quando histórico está vazio e status no Supabase é null,
 * consulta as notas recentes do Kommo procurando uma resposta canônica do
 * próprio agente que tenha pedido escolha de polo. Cobre o caso em que o
 * `n8n_chat_histories` veio vazio por race/falha de gravação/reset.
 *
 * @param {Record<string,string>} env
 * @param {number|string|null} leadId
 * @returns {Promise<boolean>} true se uma das últimas notas pedia polo.
 */
async function recentKommoNoteAskedPoloPreForm(env, leadId) {
  if (!leadId) return false
  try {
    const r = await listLeadNotes(env, leadId, { limit: 6, order: 'desc' })
    const notes = Array.isArray(r?.notes) ? r.notes : []
    for (const n of notes) {
      const text = String(n?.params?.text || n?.text || '')
      if (!text) continue
      if (assistantAskedPoloPreFormChoice(text)) return true
    }
  } catch {
    // notas indisponíveis — falha silenciosa, mantém comportamento anterior
  }
  return false
}

/**
 * Lead confirmou matrícula → escolhe polo (1–5) → dispara Formulario_Sum.
 */
export async function tryHandlePoloPreFormFlow(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  if (!telefone || !String(userMessage || '').trim()) return null

  const historyMessages = filterHistoryMessagesForAgent(input.historyMessages || [])
  const lastAssist = lastAssistantText(historyMessages)

  const row = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_INSCRICAO_SELECT)
  const status = row?.[FORM_STATUS_FIELD] ?? null
  let inPoloChoiceStep =
    status === INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM || assistantAskedPoloPreFormChoice(lastAssist)

  // Fix 2 — fallback de contexto via notas Kommo quando histórico veio vazio.
  // Só ativa se a mensagem do lead "parece polo" (número ou nome), para não
  // engatilhar em mensagens não relacionadas.
  let kommoFallbackUsed = false
  if (!inPoloChoiceStep && !status && matchPoloFromUserMessage(userMessage)) {
    const leadIdForCheck = await resolveLeadId(env, telefone, leadIdHint)
    const recentlyAsked = await recentKommoNoteAskedPoloPreForm(env, leadIdForCheck)
    if (recentlyAsked) {
      inPoloChoiceStep = true
      kommoFallbackUsed = true
      console.log(
        `[${executionId || 'inscricaoPolo'}] POLO_PRE_FORM kommo_fallback=true lead=${leadIdForCheck ?? 'n/a'} ` +
          `historyLen=${historyMessages.length} status=null`,
      )
    }
  }

  if (!inPoloChoiceStep) return null

  const idLead = await resolveLeadId(env, telefone, leadIdHint)
  const polo = matchPoloFromUserMessage(userMessage)

  if (!polo) {
    const reply = messageMentionsUnlistedPoloLocation(userMessage)
      ? buildPoloOutroLocalidadeReply()
      : buildPoloConfirmacaoInvalidaReply()
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'polo_pre_form_invalido', ok: false }],
        ctxSnapshot: { inscricaoForm: status },
      }),
    }
  }

  const unidade = resolvePoloUnidadeCode(polo.id, env)
  await ensureDadosClienteRow(env, {
    telefone,
    idLead,
    fields: {
      polo_inscricao_escolhido: polo.nome,
      captacao_unidade: unidade,
      [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_AGUARDANDO,
    },
  }).catch(() => {})
  await updateDadosCliente(env, {
    telefone,
    fields: {
      polo_inscricao_escolhido: polo.nome,
      captacao_unidade: unidade,
      [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_AGUARDANDO,
    },
  }).catch(() => {})

  const delivery = await deliverInscricaoForm(env, {
    telefone,
    leadId: idLead,
    executionId,
    forceResend: false,
  })
  const sendOk = Boolean(delivery.result?.ok)
  const ack = buildPoloEscolhidoAckReply(polo, { pushName })
  const formReply = sendOk ? ack : buildInscricaoFormSentReply({ pushName })

  console.log(
    `[inscricaoPolo] pre_form polo=${polo.id} lead=${idLead ?? 'n/a'} form_ok=${sendOk} delivery=${delivery.delivery}`,
  )

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      ok: sendOk,
      reply: formReply,
      steps: [
        { type: 'polo_pre_form_escolhido', polo: polo.id, unidade, ok: true },
        {
          type: 'inscricao_form_start',
          delivery: delivery.delivery,
          ok: sendOk,
          bot_id: delivery.result?.botId,
        },
      ],
      toolCalls: [
        {
          tool: 'polo_pre_form',
          args: { telefone, polo: polo.id, unidade },
          result: sendOk ? 'Polo registrado e formulário disparado' : delivery.result?.error,
          ok: sendOk,
        },
      ],
      ctxSnapshot: {
        inscricaoForm: sendOk ? INSCRICAO_FORM_STATUS_AGUARDANDO : INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
        poloId: polo.id,
        poloNome: polo.nome,
        unidade,
      },
    }),
  }
}

/**
 * Lead escolheu polo (status aguardando_escolha_polo pós-form) → grava e dispara captação.
 */
export async function tryHandlePoloEscolhaFlow(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  if (!telefone || !String(userMessage || '').trim()) return null

  const row = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_INSCRICAO_SELECT)
  const status = row?.[FORM_STATUS_FIELD] ?? null
  if (status !== INSCRICAO_FORM_STATUS_AGUARDANDO_POLO) return null

  const idLead = await resolveLeadId(env, telefone, leadIdHint)
  const polo = matchPoloFromUserMessage(userMessage)
  if (!polo) {
    const reply = messageMentionsUnlistedPoloLocation(userMessage)
      ? buildPoloOutroLocalidadeReply()
      : buildPoloConfirmacaoInvalidaReply()
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'polo_escolha_invalida' }],
        ctxSnapshot: { inscricaoForm: status },
      }),
    }
  }

  const unidade = resolvePoloUnidadeCode(polo.id, env)

  await updateDadosCliente(env, {
    telefone,
    fields: {
      polo_inscricao_escolhido: polo.nome,
      captacao_unidade: unidade,
    },
  }).catch(() => {})

  const snapRes = idLead ? await fetchLeadFormSnapshot(env, idLead) : { ok: false }
  const snapshot = snapRes.ok ? { ...snapRes.snapshot } : {}
  snapshot.unidade = unidade
  snapshot.polo_inscricao = polo.nome

  const capResult = await executeCaptacaoAfterFormResolved(env, {
    telefone,
    idLead,
    executionId,
    model,
    pushName,
    t0,
    snapshotOverride: snapshot,
  })

  const ack = buildPoloEscolhidoAckReply(polo, { pushName, afterForm: true })
  const baseReply = capResult?.reply
  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      ok: capResult?.ok !== false,
      reply: baseReply && String(baseReply).trim() ? baseReply : ack,
      steps: [
        { type: 'polo_escolhido', polo: polo.id, unidade },
        ...(capResult?.steps || []),
      ],
      toolCalls: capResult?.toolCalls || [],
      ctxSnapshot: {
        inscricaoForm: capResult?.ctxForm,
        poloId: polo.id,
        poloNome: polo.nome,
        unidade,
        sumareCaptacao: true,
        contratoWhatsappSent: Boolean(capResult?.contratoWhatsappSent),
        skipSchedulerWhatsapp: Boolean(capResult?.skipSchedulerWhatsapp),
      },
    }),
  }
}
