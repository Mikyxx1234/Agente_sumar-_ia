/**
 * Pós link do contrato: reenvio do link, lembrete de comprovante e recebimento do print.
 * Roda antes do gate atendimento_ia=pause (matrícula com captacao não pausa a IA nesta etapa).
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
  messageAsksContratoLinkResend,
  messageLooksLikePaymentProof,
  buildContratoLinkResendReply,
  buildPagamentoSemComprovanteReply,
  buildComprovantePagamentoRecebidoReply,
} from '../libShared/inscricaoFormHeuristics.js'
import { messageIsInboundMediaPlaceholder } from '../libShared/scopeHeuristics.js'
import {
  fetchDadosClienteByTelefone,
  updateDadosCliente,
  getLeadIdByTelefone,
} from './dadosClienteStore.js'
import { runDistribuirHumano, formatDistribuirHumanoReply } from './distribuirHumanoTool.js'
import { createLeadNote } from './kommoClient.js'

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

async function getClienteRow(env, telefone) {
  return fetchDadosClienteByTelefone(
    env,
    telefone,
    `${FORM_STATUS_FIELD},id_lead,captacao_contrato_link,captacao_candidato_id,captacao_comprovante_at`,
  )
}

async function claimComprovanteExclusive(env, telefone) {
  const row = await getClienteRow(env, telefone)
  if (row?.[FORM_STATUS_FIELD] !== INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) {
    return { claimed: false, reason: 'status_not_waiting', status: row?.[FORM_STATUS_FIELD], row }
  }
  const upd = await updateDadosCliente(env, {
    telefone,
    fields: {
      [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
      captacao_comprovante_at: new Date().toISOString(),
      atendimento_ia: 'pause',
    },
  })
  if (upd.ok && upd.matched) return { claimed: true, row }
  const again = await getClienteRow(env, telefone)
  if (again?.[FORM_STATUS_FIELD] === INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO) {
    return { claimed: false, reason: 'already_received', row: again }
  }
  return { claimed: false, reason: 'claim_update_failed', row: again }
}

function userClaimsPaidWithoutProof(text) {
  const t = String(text || '').toLowerCase()
  if (messageLooksLikePaymentProof(text)) return false
  return /\b(paguei|pagamento\s+feito|j[aá]\s+paguei|efetuei\s+o\s+pagamento)\b/i.test(t)
}

/**
 * @returns {Promise<{ handled: boolean, result?: object }|null>}
 */
export async function tryHandleMatriculaAceitePagamentoFlow(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  if (!telefone || !String(userMessage || '').trim()) return null

  const row = await getClienteRow(env, telefone)
  const status = row?.[FORM_STATUS_FIELD] ?? null
  const contractUrl = String(row?.captacao_contrato_link || '').trim()
  const candidatoId = String(row?.captacao_candidato_id || '').trim()

  if (status === INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO) {
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply:
          'Já recebemos seu comprovante! Nossa equipe está conferindo e um consultor da Faculdade Sumaré fala com você em breve por aqui, tudo bem?',
        steps: [{ type: 'comprovante_already_received' }],
        ctxSnapshot: { inscricaoForm: status },
      }),
    }
  }

  if (status !== INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) return null

  const idLead =
    (Number.isFinite(Number(leadIdHint)) && Number(leadIdHint) > 0 ? Number(leadIdHint) : null) ||
    (await getLeadIdByTelefone(env, telefone))

  const sanitized = String(userMessage || '').trim()
  if (
    /\brecebi\s+o\s+link\b/i.test(sanitized) ||
    /\bobrigad[oa]\s+por\s+enviar\b/i.test(sanitized)
  ) {
    const reply = contractUrl
      ? buildContratoLinkResendReply({ pushName, contractUrl })
      : buildContratoLinkResendReply({ pushName, contractUrl: '' })
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'contrato_link_clarify_resend', ok: Boolean(contractUrl) }],
        ctxSnapshot: { inscricaoForm: status, contractUrl: contractUrl || null },
      }),
    }
  }

  if (messageAsksContratoLinkResend(userMessage)) {
    const reply = buildContratoLinkResendReply({ pushName, contractUrl })
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'contrato_link_resend' }],
        ctxSnapshot: { inscricaoForm: status, contractUrl: contractUrl || null },
      }),
    }
  }

  const isProof =
    messageLooksLikePaymentProof(userMessage) || messageIsInboundMediaPlaceholder(userMessage)

  if (!isProof) {
    if (userClaimsPaidWithoutProof(userMessage)) {
      const reply = buildPagamentoSemComprovanteReply({ pushName, contractUrl })
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply,
          steps: [{ type: 'pagamento_aguardando_comprovante' }],
          ctxSnapshot: { inscricaoForm: status },
        }),
      }
    }
    return null
  }

  const claim = await claimComprovanteExclusive(env, telefone)
  if (!claim.claimed) {
    if (claim.reason === 'already_received') {
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply:
            'Já recebemos seu comprovante! Um consultor da Faculdade Sumaré segue com você em breve por aqui.',
          steps: [{ type: 'comprovante_dedupe' }],
          ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO },
        }),
      }
    }
    return null
  }

  const reply = buildComprovantePagamentoRecebidoReply({ pushName })

  const toolCalls = []
  const steps = [
    { type: 'comprovante_pagamento_recebido', candidato_id: candidatoId || null },
  ]

  if (idLead) {
    await createLeadNote(
      env,
      idLead,
      `Comprovante de pagamento recebido via WhatsApp (candidato ${candidatoId || 'n/a'}). Aguardando validação do consultor.`,
    ).catch(() => {})
  }

  const dist = await runDistribuirHumano(env, {
    telefone,
    id_lead: idLead,
    motivo: 'consultor',
  })
  steps.push({
    type: 'distribuir_humano_pos_comprovante',
    ok: Boolean(dist.ok),
    handoff_mode: dist.handoff_mode,
  })
  toolCalls.push({
    tool: 'distribuir_humano',
    args: { telefone, id_lead: idLead, motivo: 'consultor' },
    result: formatDistribuirHumanoReply(dist),
    ok: Boolean(dist.ok),
  })

  console.log(
    `[inscricaoAceite] telefone=${telefone} lead=${idLead ?? 'n/a'} comprovante_ok distrib=${Boolean(dist.ok)}`,
  )

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps,
      toolCalls,
      ctxSnapshot: {
        inscricaoForm: INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
        comprovanteRecebido: true,
        iaPaused: true,
      },
    }),
  }
}
