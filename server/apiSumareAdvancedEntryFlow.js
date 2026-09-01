/**
 * Bootstrap de leads Api Sumaré em estágios avançados (inscrição / aguardando pagamento).
 * Verifica CPF no card Kommo, consulta inscrição na API Sumaré e retoma o fluxo.
 *
 * A abertura (primeiro contato) é feita pelos salesbots Kommo 49977 / 49979.
 * Este handler só roda quando o lead já enviou mensagem (flush do buffer).
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_API_SUMARE_AGUARDANDO_CPF,
  INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
  buildPagamentoSemComprovanteReply,
  matriculaPosFormAlreadyProcessed,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  parseGerarCandidatoPayload,
} from '../libShared/captacaoGerarOutcome.js'
import {
  isApiSumareAdvancedFunnelEnabled,
  isApiSumareOrigemSnapshot,
  extractCpfFromMessage,
} from '../libShared/apiSumareOrigemHeuristics.js'
import {
  AGENT_FUNNEL_STATUS_INSCRICAO,
  AGENT_FUNNEL_STATUS_AGUARDANDO_PAGAMENTO,
} from './kommoAgentFunnelGate.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import { mirrorKommoCardToDadosCliente } from './kommoCardMirror.js'
import {
  ensureDadosClienteRow,
  updateDadosCliente,
  getLeadIdByTelefone,
  fetchDadosClienteByTelefone,
} from './dadosClienteStore.js'
import { executeCaptacaoAfterFormResolved } from './inscricaoPostFormPipeline.js'
import {
  buildGerarCandidatoQueryAsync,
  consultarStatusCandidato,
  extractCandidatoId,
  extractCandidatoStatusString,
  gerarCandidatoIngresso,
  isSumareCaptacaoEnabled,
  normalizeCpf,
  resolvePortalUrlForCandidato,
} from './sumareCaptacaoClient.js'
import { createLeadAuditNote } from './kommoClient.js'
import { buildFacultyContactRedirectReply } from '../libShared/humanHandoffHeuristics.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

function buildAgentReturn({ executionId, model, t0, reply, steps, ctxSnapshot, ok = true }) {
  return {
    ok,
    reply,
    toolCalls: [],
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
  const id = Number(leadIdHint)
  if (Number.isFinite(id) && id > 0) return id
  const fromDb = await getLeadIdByTelefone(env, telefone)
  return fromDb != null ? Number(fromDb) : null
}

async function setFormStatus(env, telefone, status, leadId) {
  await ensureDadosClienteRow(env, { telefone, idLead: leadId, fields: { [FORM_STATUS_FIELD]: status } }).catch(
    () => {},
  )
  return updateDadosCliente(env, { telefone, fields: { [FORM_STATUS_FIELD]: status } }).catch(() => null)
}

function buildAskCpfReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Obrigado${nameBit}! Para localizar sua inscrição na Faculdade Sumaré, ` +
    `preciso que você me informe seu *CPF* (somente números ou com pontuação).`
  )
}

function buildInscricaoNaoEncontradaReply(opts = {}) {
  return buildFacultyContactRedirectReply({ pushName: opts.pushName })
}

async function lookupCandidatoByGerar(env, snapshot, telefone) {
  const params = await buildGerarCandidatoQueryAsync(snapshot, telefone, env)
  const gerar = await gerarCandidatoIngresso(env, params)
  if (!gerar.ok) {
    return { ok: false, error: gerar.error || gerar.raw, steps: [{ type: 'api_sumare_gerar', ok: false }] }
  }
  const parsed = parseGerarCandidatoPayload(gerar.data)
  const candidatoId = parsed?.candidatoId || extractCandidatoId(gerar.data)
  if (!candidatoId) {
    return { ok: false, reason: 'candidato_not_found', parsed, steps: [{ type: 'api_sumare_gerar', ok: true }] }
  }
  return { ok: true, candidatoId, parsed, params, steps: [{ type: 'api_sumare_gerar', ok: true, candidatoId }] }
}

async function persistCandidatoForPagamento(env, { telefone, leadId, candidatoId, snapshot }) {
  const statusRes = await consultarStatusCandidato(env, candidatoId)
  const statusStr = extractCandidatoStatusString(statusRes.data)
  const portal = resolvePortalUrlForCandidato(env, candidatoId, statusStr, {
    cpf: snapshot?.cpf,
  })
  await updateDadosCliente(env, {
    telefone,
    fields: {
      [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
      captacao_candidato_id: String(candidatoId),
      captacao_contrato_link: portal.url || null,
      captacao_curso_codigo: snapshot?.curso_inscricao || null,
      captacao_curso_nome: snapshot?.curso_inscricao || null,
      inscricao_form_recebido_at: new Date().toISOString(),
      atendimento_ia: null,
    },
  }).catch(() => {})
  if (leadId) {
    await createLeadAuditNote(
      env,
      leadId,
      `Api Sumaré — inscrição localizada (candidato ${candidatoId}); aguardando comprovante de pagamento.`,
    ).catch(() => {})
  }
  return portal.url || ''
}

/**
 * @returns {Promise<null | { handled: true, result: object }>}
 */
export async function tryHandleApiSumareAdvancedEntry(env, input) {
  if (!isApiSumareAdvancedFunnelEnabled(env)) return null

  const { telefone, userMessage, executionId, model, pushName, t0: t0In } = input
  const t0 = t0In || Date.now()
  if (!telefone || !String(userMessage || '').trim()) return null

  const leadId = await resolveLeadId(env, telefone, input.leadId)
  if (!leadId) return null

  const snapRes = await fetchLeadFormSnapshot(env, leadId)
  if (!snapRes.ok || !snapRes.snapshot) return null
  const snapshot = { ...snapRes.snapshot }
  if (!isApiSumareOrigemSnapshot(snapshot)) return null

  const statusId = Number(snapshot.status_id)
  const isInscricaoQueue = statusId === AGENT_FUNNEL_STATUS_INSCRICAO
  const isPagamentoQueue = statusId === AGENT_FUNNEL_STATUS_AGUARDANDO_PAGAMENTO
  if (!isInscricaoQueue && !isPagamentoQueue) return null

  const row = await fetchDadosClienteByTelefone(env, telefone, FORM_STATUS_FIELD).catch(() => null)
  const formStatus = String(row?.[FORM_STATUS_FIELD] || '').trim()

  if (formStatus === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) return null
  if (formStatus === INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR) return null
  if (matriculaPosFormAlreadyProcessed(row) && formStatus !== INSCRICAO_FORM_STATUS_API_SUMARE_AGUARDANDO_CPF) {
    return null
  }

  await mirrorKommoCardToDadosCliente(env, { telefone, leadId, force: true }).catch(() => {})

  let cpf = normalizeCpf(snapshot.cpf)
  if (!cpf) cpf = extractCpfFromMessage(userMessage)
  if (cpf) snapshot.cpf = cpf

  if (!cpf) {
    if (formStatus !== INSCRICAO_FORM_STATUS_API_SUMARE_AGUARDANDO_CPF) {
      await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_API_SUMARE_AGUARDANDO_CPF, leadId)
    }
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: buildAskCpfReply({ pushName }),
        steps: [{ type: 'api_sumare_aguardando_cpf' }],
        ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_API_SUMARE_AGUARDANDO_CPF, apiSumareEntry: true },
      }),
    }
  }

  if (!isSumareCaptacaoEnabled(env)) {
    await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR, leadId)
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: buildInscricaoNaoEncontradaReply({ pushName }),
        steps: [{ type: 'api_sumare_captacao_disabled' }],
        ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR },
      }),
    }
  }

  const lookup = await lookupCandidatoByGerar(env, snapshot, telefone)
  if (!lookup.ok || !lookup.candidatoId) {
    await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR, leadId)
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: buildInscricaoNaoEncontradaReply({ pushName }),
        steps: lookup.steps || [{ type: 'api_sumare_inscricao_nao_encontrada' }],
        ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR },
      }),
    }
  }

  if (isPagamentoQueue) {
    const contractUrl = await persistCandidatoForPagamento(env, {
      telefone,
      leadId,
      candidatoId: lookup.candidatoId,
      snapshot,
    })
    const reply = buildPagamentoSemComprovanteReply({ pushName, contractUrl })
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [
          ...(lookup.steps || []),
          { type: 'api_sumare_pagamento_bootstrap', candidatoId: lookup.candidatoId },
        ],
        ctxSnapshot: {
          inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
          apiSumareEntry: true,
          candidatoId: lookup.candidatoId,
        },
      }),
    }
  }

  const cap = await executeCaptacaoAfterFormResolved(env, {
    telefone,
    idLead: leadId,
    executionId,
    model,
    pushName,
    t0,
    snapshotOverride: snapshot,
    useCandidatoId: lookup.candidatoId,
  })

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply: cap.reply,
      steps: [...(lookup.steps || []), ...(cap.steps || [])],
      ctxSnapshot: {
        inscricaoForm: cap.ctxForm,
        apiSumareEntry: true,
        candidatoId: lookup.candidatoId,
        skipSchedulerWhatsapp: cap.skipSchedulerWhatsapp,
        contratoWhatsappSent: cap.contratoWhatsappSent,
      },
    }),
  }
}
