/**
 * Confirmação quando o candidato já possui inscrição na Sumaré (outro curso ou mesma etapa).
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO,
  buildMantemInscricaoExistenteReply,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  messageConfirmsNovaInscricao,
  messageDeclinesNovaInscricao,
} from '../libShared/captacaoGerarOutcome.js'
import {
  fetchDadosClienteByTelefone,
  updateDadosCliente,
} from './dadosClienteStore.js'
import { resolveCrmLeadId } from './crmAdapter.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import {
  consultarStatusCandidato,
  extractCandidatoStatusString,
  resolvePortalUrlForCandidato,
  solicitarAceiteContrato,
} from './sumareCaptacaoClient.js'
import { finalizeCaptacaoForCandidato } from './matriculaCaptacaoPipeline.js'
import { sendMessageWithNote } from './whatsappSender.js'
import { executeCaptacaoAfterFormResolved } from './inscricaoPostFormPipeline.js'
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

async function getRow(env, telefone) {
  return fetchDadosClienteByTelefone(
    env,
    telefone,
    [
      FORM_STATUS_FIELD,
      'captacao_candidato_id',
      'captacao_pending_candidato_id',
      'captacao_curso_codigo',
      'captacao_curso_nome',
      'captacao_contrato_link',
      'kommo_cpf',
    ].join(','),
  )
}

/**
 * @returns {Promise<{ handled: boolean, result?: object }|null>}
 */
export async function tryHandleCaptacaoInscricaoExistenteFlow(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  if (!telefone || !String(userMessage || '').trim()) return null

  const row = await getRow(env, telefone)
  const status = row?.[FORM_STATUS_FIELD] ?? null
  if (status !== INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO) return null

  const priorId = String(row?.captacao_candidato_id || '').trim()
  const pendingId = String(row?.captacao_pending_candidato_id || '').trim()
  const leadId = await resolveCrmLeadId(env, telefone, leadIdHint)

  if (messageConfirmsNovaInscricao(userMessage)) {
    const candidatoId = pendingId || priorId
    if (!candidatoId) {
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply: buildFacultyContactRedirectReply({ pushName }),
          steps: [{ type: 'captacao_confirm', ok: false, reason: 'missing_pending_candidato' }],
          ctxSnapshot: { inscricaoForm: status },
        }),
      }
    }

    await solicitarAceiteContrato(env, candidatoId).catch(() => {})

    if (leadId) {
      const snapRes = await fetchLeadFormSnapshot(env, leadId).catch(() => ({ ok: false }))
      const cap = await executeCaptacaoAfterFormResolved(env, {
        telefone,
        idLead: leadId,
        executionId,
        model,
        pushName,
        t0,
        snapshotOverride: snapRes.ok ? snapRes.snapshot : undefined,
        confirmedNovaInscricao: true,
        useCandidatoId: candidatoId,
      })
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply: cap.reply,
          steps: cap.steps,
          ctxSnapshot: { inscricaoForm: cap.ctxForm, captacaoConfirm: 'nova_inscricao_sim' },
        }),
      }
    }

    const fin = await finalizeCaptacaoForCandidato(env, {
      telefone,
      leadId,
      pushName,
      executionId,
      candidatoId,
      cursoCodigo: row?.captacao_curso_codigo,
      cursoNome: row?.captacao_curso_nome,
    })
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: fin.reply,
        steps: [{ type: 'captacao_confirm', ok: true, candidatoId }],
        ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE },
      }),
    }
  }

  if (messageDeclinesNovaInscricao(userMessage) && priorId) {
    const statusRes = await consultarStatusCandidato(env, priorId)
    const statusStr = extractCandidatoStatusString(statusRes.data)
    const portal = resolvePortalUrlForCandidato(env, priorId, statusStr, {
      cpf: row?.kommo_cpf || row?.cpf,
    })
    const reply = buildMantemInscricaoExistenteReply({
      pushName,
      contractUrl: portal.url,
      cursoNome: row?.captacao_curso_nome || 'sua candidatura atual',
    })
    await updateDadosCliente(env, {
      telefone,
      fields: {
        [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
        captacao_pending_candidato_id: null,
        captacao_contrato_link: portal.url,
        captacao_contrato_link_at: new Date().toISOString(),
      },
    })
    await sendMessageWithNote(env, { telefone, text: reply, leadId, executionId })
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'captacao_confirm', ok: true, choice: 'manter_existente', candidatoId: priorId }],
        ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE },
      }),
    }
  }

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply:
        'Para seguir, responda *sim* se deseja fazer uma *nova inscrição* no outro curso, ou *não* para continuar com a candidatura que já está em andamento.',
      steps: [{ type: 'captacao_confirm', ok: true, awaiting: true }],
      ctxSnapshot: { inscricaoForm: status },
    }),
  }
}
