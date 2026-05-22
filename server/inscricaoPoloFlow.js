/**
 * Pós Form Sumar: pergunta polo → API Captação.
 * Prioridade: dados já no card Kommo (polo_inscricao / unidade).
 */

import { INSCRICAO_FORM_STATUS_AGUARDANDO_POLO } from '../libShared/inscricaoFormHeuristics.js'
import {
  matchPoloFromUserMessage,
  resolvePoloUnidadeCode,
  buildPoloConfirmacaoInvalidaReply,
  buildPoloEscolhidoAckReply,
} from '../libShared/sumarePoloCatalog.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import {
  updateDadosCliente,
  fetchDadosClienteByTelefone,
  getLeadIdByTelefone,
} from './dadosClienteStore.js'
import { DADOS_CLIENTE_INSCRICAO_SELECT } from './dadosClienteInscricaoFields.js'
import { executeCaptacaoAfterFormResolved } from './inscricaoPostFormPipeline.js'

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
 * Lead escolheu polo (status aguardando_escolha_polo) → grava e dispara captação.
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
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: buildPoloConfirmacaoInvalidaReply(),
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

  const ack = buildPoloEscolhidoAckReply(polo, { pushName })
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
      },
    }),
  }
}

