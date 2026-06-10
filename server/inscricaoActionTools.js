/**
 * Executores das tools de ação de inscrição.
 *
 * Princípio: o LLM **invoca** uma destas tools quando quer disparar uma ação;
 * o servidor executa e devolve um **texto canônico** (`replyOverride`) que
 * substitui qualquer narrativa do LLM no turno. Assim a resposta que chega ao
 * lead nunca diverge da ação que realmente aconteceu.
 *
 * Cada tool grava `inscricao_form_status` ANTES de qualquer disparo
 * (salesbot/captação) — transição atômica, à prova de reentrância.
 *
 * Retorno padrão:
 *   {
 *     ok:        boolean,         // ação concluída com sucesso
 *     code:      string,          // FORM_SENT_OK | POLO_NEEDED | ...
 *     text:      string,          // mensagem curta para o LLM (tool message)
 *     replyOverride: string,      // mensagem definitiva para o lead (sobrescreve LLM)
 *     ctxSnapshot:  object,       // estado p/ telemetria
 *     steps:        array,        // passos p/ orchestratorSteps
 *   }
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  buildInscricaoFormSentReply,
  buildFormAwaitingFillReply,
  shouldBlockFormularioSumResend,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  SUMARE_POLOS_EAD,
  resolvePoloUnidadeCode,
  buildPoloEscolhaPreFormMessage,
  buildPoloEscolhidoAckReply,
  buildPoloConfirmacaoInvalidaReply,
  matchPoloFromUserMessage,
  resolvePoloFromKommoSnapshot,
} from '../libShared/sumarePoloCatalog.js'
import {
  ensureDadosClienteRow,
  fetchDadosClienteByTelefone,
  getLeadIdByTelefone,
} from './dadosClienteStore.js'
import { findLeadByPhone } from './kommoClient.js'
import { deliverInscricaoForm } from './inscricaoFormFlow.js'
import { executeCaptacaoAfterFormResolved } from './inscricaoPostFormPipeline.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import { DADOS_CLIENTE_FORM_GUARD_SELECT } from './dadosClienteInscricaoFields.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

function resolvePoloEntry(poloId) {
  if (!poloId) return null
  const id = String(poloId).trim().toLowerCase()
  return SUMARE_POLOS_EAD.find((p) => p.id === id) || matchPoloFromUserMessage(id)
}

async function resolveLeadId(env, telefone, hint) {
  if (Number.isFinite(Number(hint)) && Number(hint) > 0) return Number(hint)
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

/**
 * Resolve polo já gravado em Supabase ou no card Kommo (não força fallback).
 * @returns {{ poloNome: string, unidade: string, source: string } | null}
 */
async function resolveExistingPolo(env, { telefone, leadId }) {
  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    `${FORM_STATUS_FIELD},polo_inscricao_escolhido,captacao_unidade`,
  )
  const poloNome = String(row?.polo_inscricao_escolhido || '').trim()
  const unidade = String(row?.captacao_unidade || '').trim()
  if (poloNome && unidade) return { poloNome, unidade, source: 'supabase' }
  if (leadId != null) {
    const snap = await fetchLeadFormSnapshot(env, leadId).catch(() => ({ ok: false }))
    if (snap.ok && snap.snapshot) {
      const resolved = resolvePoloFromKommoSnapshot(snap.snapshot, env)
      if (resolved) {
        return { poloNome: resolved.polo.nome, unidade: resolved.unidade, source: resolved.source }
      }
    }
  }
  return null
}

async function gravarPoloEStatusAguardando(env, { telefone, leadId, polo, unidade }) {
  return ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: {
      polo_inscricao_escolhido: polo.nome,
      captacao_unidade: unidade,
      [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_AGUARDANDO,
    },
  })
}

async function gravarStatus(env, { telefone, leadId, status }) {
  return ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: { [FORM_STATUS_FIELD]: status },
  })
}

/** Tool: `enviar_form_sumar_inscricao`. */
export async function runEnviarFormSumarInscricao(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const curso = String(args.curso || '').trim()
  const poloId = args.polo_id ? String(args.polo_id).trim().toLowerCase() : null
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'enviar_form_sumar_inscricao', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const leadId = await resolveLeadId(env, telefone, ctx.leadId)

  const guardRow = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_FORM_GUARD_SELECT)
  if (shouldBlockFormularioSumResend(guardRow)) {
    const status = guardRow?.[FORM_STATUS_FIELD] ?? null
    const reply =
      status === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
        ? 'Já recebemos seu formulário e enviamos o link para concluir a matrícula. Se precisar do link de pagamento de novo, é só pedir por aqui.'
        : buildFormAwaitingFillReply({ pushName })
    return {
      ok: true,
      code: 'FORM_ALREADY_SENT',
      text: 'Formulário já enviado ou inscrição já avançou — não reativar Formulario_Sum.',
      replyOverride: reply,
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: status || 'blocked_resend',
        blockedResend: true,
      },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: true, code: 'FORM_ALREADY_SENT' }],
    }
  }

  let polo = null
  let unidade = null
  if (poloId) {
    const entry = resolvePoloEntry(poloId)
    if (!entry) {
      const reply = buildPoloConfirmacaoInvalidaReply()
      await gravarStatus(env, { telefone, leadId, status: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM }).catch(() => {})
      return {
        ok: false,
        code: 'INVALID_POLO',
        text: `polo_id inválido: ${poloId}. Use sao_miguel | barra_funda | tatuape | santana | pinheiros.`,
        replyOverride: reply,
        ctxSnapshot: {
          inscricaoActionTool: 'enviar_form_sumar_inscricao',
          inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
          poloIdInformado: poloId,
        },
        steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'INVALID_POLO' }],
      }
    }
    polo = entry
    unidade = resolvePoloUnidadeCode(polo.id, env)
  } else {
    const existing = await resolveExistingPolo(env, { telefone, leadId })
    if (existing) {
      const matched = matchPoloFromUserMessage(existing.poloNome)
      polo = matched || { id: 'supabase', nome: existing.poloNome, endereco: '' }
      unidade = existing.unidade
    }
  }

  if (!polo) {
    await gravarStatus(env, {
      telefone,
      leadId,
      status: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
    }).catch(() => {})
    const reply = buildPoloEscolhaPreFormMessage({ pushName })
    return {
      ok: false,
      code: 'POLO_NEEDED',
      text: 'Polo ainda não definido — pedi escolha de polo (1-5) ao lead. NÃO afirme que enviou o formulário.',
      replyOverride: reply,
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
        curso,
      },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'POLO_NEEDED' }],
    }
  }

  await gravarPoloEStatusAguardando(env, { telefone, leadId, polo, unidade }).catch(() => {})

  const delivery = await deliverInscricaoForm(env, {
    telefone,
    leadId,
    executionId: ctx.executionId,
    forceResend: false,
  })
  const sendOk = Boolean(delivery.result?.ok)

  if (!sendOk) {
    return {
      ok: false,
      code: delivery.result?.code || 'FORM_SEND_FAILED',
      text: `Falha ao disparar Form Sumar: ${delivery.result?.error || delivery.result?.code || 'erro'}.`,
      replyOverride:
        'Queremos muito te ajudar com a inscrição na Faculdade Sumaré! No momento não consegui abrir o formulário automático no WhatsApp — um consultor entrará em contato em breve por aqui.',
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
        delivery: delivery.delivery,
        poloId: polo.id,
        unidade,
        error: delivery.result?.error,
      },
      steps: [
        {
          type: 'tool_action',
          tool: 'enviar_form_sumar_inscricao',
          ok: false,
          code: delivery.result?.code || 'FORM_SEND_FAILED',
          delivery: delivery.delivery,
        },
      ],
    }
  }

  const reply = buildInscricaoFormSentReply({ pushName, resend: false })
  return {
    ok: true,
    code: 'FORM_SENT_OK',
    text: `Form Sumar disparado (delivery=${delivery.delivery}). Estado: ${INSCRICAO_FORM_STATUS_AGUARDANDO}.`,
    replyOverride: reply,
    ctxSnapshot: {
      inscricaoActionTool: 'enviar_form_sumar_inscricao',
      inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
      delivery: delivery.delivery,
      poloId: polo.id,
      poloNome: polo.nome,
      unidade,
      curso,
    },
    steps: [
      {
        type: 'tool_action',
        tool: 'enviar_form_sumar_inscricao',
        ok: true,
        delivery: delivery.delivery,
        bot_id: delivery.result?.botId,
        polo: polo.id,
      },
    ],
  }
}

/** Tool: `registrar_polo_inscricao`. */
export async function runRegistrarPoloInscricao(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const poloId = String(args.polo_id || '').trim().toLowerCase()
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'registrar_polo_inscricao', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const polo = resolvePoloEntry(poloId)
  if (!polo) {
    return {
      ok: false,
      code: 'INVALID_POLO',
      text: `polo_id inválido: "${poloId}". Use sao_miguel | barra_funda | tatuape | santana | pinheiros.`,
      replyOverride: buildPoloConfirmacaoInvalidaReply(),
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
        poloIdInformado: poloId,
      },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: false, code: 'INVALID_POLO' }],
    }
  }

  const leadId = await resolveLeadId(env, telefone, ctx.leadId)
  const unidade = resolvePoloUnidadeCode(polo.id, env)

  const guardRow = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_FORM_GUARD_SELECT)
  if (shouldBlockFormularioSumResend(guardRow)) {
    return {
      ok: true,
      code: 'FORM_ALREADY_SENT',
      text: 'Polo reconhecido, mas formulário já foi enviado — não reativar Formulario_Sum.',
      replyOverride: buildFormAwaitingFillReply({ pushName }),
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: guardRow?.[FORM_STATUS_FIELD] || 'blocked_resend',
        poloId: polo.id,
        blockedResend: true,
      },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: true, code: 'FORM_ALREADY_SENT' }],
    }
  }

  await gravarPoloEStatusAguardando(env, { telefone, leadId, polo, unidade }).catch(() => {})

  const delivery = await deliverInscricaoForm(env, {
    telefone,
    leadId,
    executionId: ctx.executionId,
    forceResend: false,
  })
  const sendOk = Boolean(delivery.result?.ok)

  if (!sendOk) {
    return {
      ok: false,
      code: delivery.result?.code || 'FORM_SEND_FAILED',
      text: `Polo ${polo.nome} gravado, mas falha ao disparar Form Sumar: ${delivery.result?.error || delivery.result?.code || 'erro'}.`,
      replyOverride:
        `Anotamos o polo *${polo.nome}*. No momento não consegui abrir o formulário automático aqui no WhatsApp — um consultor da Faculdade Sumaré entrará em contato em breve por aqui.`,
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
        poloId: polo.id,
        poloNome: polo.nome,
        unidade,
        delivery: delivery.delivery,
        error: delivery.result?.error,
      },
      steps: [
        {
          type: 'tool_action',
          tool: 'registrar_polo_inscricao',
          ok: false,
          code: delivery.result?.code || 'FORM_SEND_FAILED',
          polo: polo.id,
        },
      ],
    }
  }

  const reply = buildPoloEscolhidoAckReply(polo, { pushName })
  return {
    ok: true,
    code: 'POLO_REGISTRADO_OK',
    text: `Polo ${polo.nome} (${unidade}) gravado e Form Sumar disparado (delivery=${delivery.delivery}). Estado: ${INSCRICAO_FORM_STATUS_AGUARDANDO}.`,
    replyOverride: reply,
    ctxSnapshot: {
      inscricaoActionTool: 'registrar_polo_inscricao',
      inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
      poloId: polo.id,
      poloNome: polo.nome,
      unidade,
      delivery: delivery.delivery,
    },
    steps: [
      {
        type: 'tool_action',
        tool: 'registrar_polo_inscricao',
        ok: true,
        polo: polo.id,
        unidade,
        delivery: delivery.delivery,
        bot_id: delivery.result?.botId,
      },
    ],
  }
}

/** Tool: `confirmar_recebimento_formulario`. */
export async function runConfirmarRecebimentoFormulario(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'confirmar_recebimento_formulario', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const leadId = await resolveLeadId(env, telefone, ctx.leadId)
  if (leadId == null) {
    return {
      ok: false,
      code: 'LEAD_NOT_FOUND',
      text: 'Não consegui localizar o lead no Kommo para concluir a inscrição. Encaminhe para consultor.',
      replyOverride:
        'Recebi seu formulário! Para seguir, preciso localizar seu cadastro — em instantes um consultor da Faculdade Sumaré fala com você por aqui, tudo bem?',
      ctxSnapshot: { inscricaoActionTool: 'confirmar_recebimento_formulario', leadNotFound: true },
      steps: [
        { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: false, code: 'LEAD_NOT_FOUND' },
      ],
    }
  }

  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    `${FORM_STATUS_FIELD},polo_inscricao_escolhido,captacao_unidade,captacao_candidato_id`,
  )
  const status = row?.[FORM_STATUS_FIELD] ?? null
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO || row?.captacao_candidato_id) {
    return {
      ok: true,
      code: 'ALREADY_PROCESSED',
      text: `Inscrição já processada (status=${status || 'concluido'}). Não dispare de novo.`,
      replyOverride:
        'Já recebemos seu formulário e iniciamos sua inscrição. Em breve nossa equipe segue com você por aqui para finalizar, tudo bem?',
      ctxSnapshot: {
        inscricaoActionTool: 'confirmar_recebimento_formulario',
        inscricaoForm: status || 'concluido',
        alreadyProcessed: true,
      },
      steps: [
        { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: true, code: 'ALREADY_PROCESSED' },
      ],
    }
  }

  let snapshotOverride = null
  const unidadeDb = String(row?.captacao_unidade || '').trim()
  const poloDb = String(row?.polo_inscricao_escolhido || '').trim()
  if (unidadeDb && poloDb) {
    const snapRes = await fetchLeadFormSnapshot(env, leadId).catch(() => ({ ok: false }))
    const snapshot = snapRes.ok ? { ...snapRes.snapshot } : {}
    snapshot.unidade = unidadeDb
    snapshot.polo_inscricao = poloDb
    snapshotOverride = snapshot
  }

  const cap = await executeCaptacaoAfterFormResolved(env, {
    telefone,
    idLead: leadId,
    executionId: ctx.executionId,
    model: ctx.model,
    pushName,
    t0: ctx.t0 || Date.now(),
    snapshotOverride,
    confirmedNovaInscricao: Boolean(ctx.confirmedNovaInscricao),
    useCandidatoId: ctx.useCandidatoId,
  })

  if (cap.ok) {
    return {
      ok: true,
      code: 'INSCRICAO_REGISTRADA_OK',
      text: `Inscrição na API Sumaré OK. Estado: ${cap.ctxForm}.`,
      replyOverride: cap.reply,
      ctxSnapshot: {
        inscricaoActionTool: 'confirmar_recebimento_formulario',
        inscricaoForm: cap.ctxForm,
        sumareCaptacao: true,
        contratoWhatsappSent: Boolean(cap.contratoWhatsappSent),
        skipSchedulerWhatsapp: Boolean(cap.skipSchedulerWhatsapp),
      },
      steps: [
        { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: true, code: 'INSCRICAO_REGISTRADA_OK' },
        ...(cap.steps || []),
      ],
      toolCalls: cap.toolCalls || [],
    }
  }

  return {
    ok: false,
    code: 'CAPTACAO_FAILED',
    text: 'Falha ao registrar inscrição na API Sumaré. Reply servidor já trata o fallback.',
    replyOverride: cap.reply,
    ctxSnapshot: {
      inscricaoActionTool: 'confirmar_recebimento_formulario',
      inscricaoForm: cap.ctxForm,
      captacaoFailed: true,
    },
    steps: [
      { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: false, code: 'CAPTACAO_FAILED' },
      ...(cap.steps || []),
    ],
    toolCalls: cap.toolCalls || [],
  }
}
