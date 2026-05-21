/**
 * Pós Form Sumar (fluxo direto):
 *   formulário respondido → salesbot matrícula 49813 + pause IA
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  messageLooksLikeFormSumarResponse,
  messageLooksLikeFormFollowUp,
  buildInscricaoFormCompleteReply,
} from '../libShared/inscricaoFormHeuristics.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { findLeadByPhone, listLeadNotes } from './kommoClient.js'
import {
  updateDadosCliente,
  getLeadIdByTelefone,
  normalizeTelefone,
  fetchDadosClienteByTelefone,
  dadosClienteTelefoneOrFilter,
} from './dadosClienteStore.js'
import { isSumareCaptacaoEnabled } from './sumareCaptacaoClient.js'
import {
  runMatriculaCaptacaoAfterForm,
  shouldRunSalesbot49813,
} from './matriculaCaptacaoPipeline.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'
const MATRICULA_BOT_ID_DEFAULT = 49813

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum',
  }
}

async function getClienteRow(env, telefone) {
  return fetchDadosClienteByTelefone(
    env,
    telefone,
    `${FORM_STATUS_FIELD},id_lead,inscricao_form_recebido_at`,
  )
}

async function setFormStatus(env, telefone, status) {
  return updateDadosCliente(env, { telefone, fields: { [FORM_STATUS_FIELD]: status } })
}

/**
 * Claim atômico: marca concluído antes do salesbot 49813 — evita 5 disparos em réplicas paralelas.
 */
async function claimMatriculaPosFormExclusive(env, telefone) {
  const { url, key, table } = getSupabaseCfg(env)
  if (!url || !key) return { claimed: false, reason: 'no_supabase' }
  const telFilter = dadosClienteTelefoneOrFilter(telefone)
  if (!telFilter) return { claimed: false, reason: 'invalid_phone' }
  const waiting = [
    INSCRICAO_FORM_STATUS_AGUARDANDO,
    INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  ].join(',')
  try {
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?${telFilter}&${FORM_STATUS_FIELD}=in.(${waiting})`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_CONCLUIDO }),
      },
    )
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      if (res.status === 400) {
        const fallback = await updateDadosCliente(env, {
          telefone,
          fields: { [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_CONCLUIDO },
        })
        if (fallback.ok && fallback.matched) {
          return { claimed: true, reason: 'fallback_update_after_patch_400' }
        }
        console.warn(
          `[inscricaoPostForm] claim patch_400 — confira coluna ${FORM_STATUS_FIELD} em ${table}. ${errBody.slice(0, 200)}`,
        )
      }
      return { claimed: false, reason: `patch_${res.status}`, detail: errBody.slice(0, 200) }
    }
    const rows = await res.json()
    if (Array.isArray(rows) && rows.length > 0) {
      return { claimed: true, reason: 'claimed_waiting_status' }
    }
    const row = await getClienteRow(env, telefone)
    const st = row?.[FORM_STATUS_FIELD] ?? null
    if (st === INSCRICAO_FORM_STATUS_CONCLUIDO) {
      return { claimed: false, reason: 'already_completed', status: st }
    }
    return { claimed: false, reason: 'no_waiting_row', status: st }
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

async function pauseAtendimentoIa(env, telefone) {
  return updateDadosCliente(env, { telefone, fields: { atendimento_ia: 'pause' } })
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

function shouldTriggerMatriculaPosForm(userMessage, status) {
  if (messageLooksLikeFormSumarResponse(userMessage)) return true
  if (
    status === INSCRICAO_FORM_STATUS_AGUARDANDO ||
    status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO
  ) {
    return messageLooksLikeFormFollowUp(userMessage, { strictAwaitingForm: true })
  }
  return false
}

function noteBlob(n) {
  return [
    n?.params?.text,
    n?.params?.message,
    n?.text,
    typeof n?.params === 'object' ? JSON.stringify(n.params) : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * O Flow do Form Sumar costuma aparecer só nas notas do Kommo
 * ("Respostas recebidas no Flow"), sem mensagem no buffer WhatsApp.
 */
export async function detectFormSumarRecebidoNoKommo(env, leadId, options = {}) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) return { detected: false, reason: 'invalid_lead' }

  const maxAgeH = Number(env.INSCRICAO_FORM_KOMMO_NOTE_MAX_AGE_H || 48)
  const maxAgeMs = (Number.isFinite(maxAgeH) && maxAgeH > 0 ? maxAgeH : 48) * 3600000
  const now = Date.now()
  const minNoteAfterMs = options.minNoteAfterIso ? Date.parse(options.minNoteAfterIso) : NaN

  const notesRes = await listLeadNotes(env, id, { limit: 50, order: 'desc' })
  if (notesRes.ok && Array.isArray(notesRes.notes)) {
    for (const n of notesRes.notes) {
      const created = n?.created_at ?? n?.date_create
      if (created) {
        const ts = Date.parse(created)
        if (!Number.isNaN(ts) && now - ts > maxAgeMs) continue
        if (!Number.isNaN(minNoteAfterMs) && !Number.isNaN(ts) && ts <= minNoteAfterMs) continue
      }
      const blob = noteBlob(n)
      if (messageLooksLikeFormSumarResponse(blob)) {
        return { detected: true, source: 'kommo_note', sample: blob.slice(0, 120) }
      }
      if (/\brespostas\s+recebidas\s+no\s+flow\b/i.test(blob)) {
        return { detected: true, source: 'kommo_note_flow', sample: blob.slice(0, 120) }
      }
    }
  }

  return { detected: false, reason: 'not_found' }
}

/**
 * Form preenchido → salesbot 49813 (matricula_pos_form) + pause IA.
 */
async function stepMatriculaPosForm(env, ctx) {
  const { telefone, idLead, executionId, model, pushName, t0, kommoFormDetected } = ctx

  const claim = await claimMatriculaPosFormExclusive(env, telefone)
  if (!claim.claimed) {
    console.log(
      `[inscricaoPostForm] lead=${idLead} matricula_pos_form skip claim=${claim.reason} status=${claim.status || 'n/a'}`,
    )
    return { handled: false, reason: claim.reason || 'matricula_claim_failed' }
  }

  const pauseRes = await pauseAtendimentoIa(env, telefone)
  const steps = [{ type: 'ia_paused', ok: pauseRes.ok }]
  const toolCalls = []
  let reply = buildInscricaoFormCompleteReply({ pushName, ok: false })
  let matriculaOk = false
  let ctxForm = 'completed'
  let skipSchedulerWhatsapp = false

  if (isSumareCaptacaoEnabled(env)) {
    const cap = await runMatriculaCaptacaoAfterForm(env, {
      telefone,
      leadId: idLead,
      pushName,
      executionId,
    })
    steps.push({
      type: 'sumare_captacao',
      ok: cap.ok,
      skipped: cap.skipped,
      candidato_id: cap.candidatoId,
      contract_url: cap.contractUrl,
      code: cap.code,
      error: cap.error,
    })
    if (cap.ok && !cap.skipped && cap.contractUrl) {
      matriculaOk = true
      ctxForm = INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
      reply = cap.reply || reply
      if (cap.whatsappOk) skipSchedulerWhatsapp = true
      toolCalls.push({
        tool: 'sumare_captacao_contrato',
        args: { telefone, id_lead: idLead, candidato: cap.candidatoId },
        result: `Link contrato enviado: ${cap.contractUrl}`,
        ok: Boolean(cap.whatsappOk),
      })
    } else if (!cap.skipped && !cap.ok) {
      reply =
        `Obrigado${pushName ? `, ${String(pushName).split(/\s+/)[0]}` : ''}! Recebemos seu formulário, mas houve um problema ao gerar sua inscrição no sistema. ` +
        `Um consultor da Faculdade Sumaré entrará em contato em breve para concluir o aceite do contrato e o pagamento.`
      toolCalls.push({
        tool: 'sumare_captacao_contrato',
        args: { telefone, id_lead: idLead },
        result: cap.error || cap.code || 'falha',
        ok: false,
      })
    }
  }

  if (!matriculaOk && (shouldRunSalesbot49813(env) || !isSumareCaptacaoEnabled(env))) {
    const salesbotRes = await runKommoSalesbot(env, idLead, 'matricula_pos_form', {
      executionId,
      note: `Form Sumar recebido — salesbot matrícula ${MATRICULA_BOT_ID_DEFAULT} (agente IA) — ${executionId || ''}`.trim(),
    })
    if (salesbotRes.ok) skipSchedulerWhatsapp = true
    matriculaOk = Boolean(salesbotRes.ok && !salesbotRes.skipped)
    steps.push({
      type: 'inscricao_form_complete',
      ok: matriculaOk,
      bot_id: salesbotRes.botId,
    })
    toolCalls.push({
      tool: 'matricula_pos_form',
      args: { telefone, id_lead: idLead },
      result: matriculaOk ? `Salesbot ${salesbotRes.botId} disparado` : salesbotRes.text || 'falha',
      ok: matriculaOk,
    })
    if (matriculaOk && !isSumareCaptacaoEnabled(env)) {
      await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_CONCLUIDO).catch(() => {})
      reply = buildInscricaoFormCompleteReply({ pushName, ok: true })
      ctxForm = 'completed'
    }
  }

  if (!isSumareCaptacaoEnabled(env) && !matriculaOk) {
    reply = buildInscricaoFormCompleteReply({ pushName, ok: false })
  }

  if (ctxForm !== INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) {
    await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_CONCLUIDO).catch(() => {})
    ctxForm = INSCRICAO_FORM_STATUS_CONCLUIDO
  }

  await updateDadosCliente(env, {
    telefone,
    fields: { inscricao_form_recebido_at: new Date().toISOString() },
  }).catch(() => {})

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
        inscricaoForm: ctxForm,
        iaPaused: true,
        sumareCaptacao: isSumareCaptacaoEnabled(env),
        contratoLinkSent: matriculaOk && isSumareCaptacaoEnabled(env),
        skipSchedulerWhatsapp,
      },
    }),
  }
}

/**
 * Pipeline pós-formulário: dispara 49813 assim que o formulário é detectado.
 * @param {boolean} [input.schedulerTick] — tick do scheduler (leads presos em aguardando_distribuicao)
 */
export async function tryProcessInscricaoPostFormPipeline(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0, schedulerTick } = input
  if (!telefone) return null

  const row = await getClienteRow(env, telefone)
  const status = row?.[FORM_STATUS_FIELD] ?? null

  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO) return null
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) return null

  const idLead = await resolveLeadId(env, telefone, leadIdHint)

  let kommoFormDone = false
  let detectSource = ''
  if (schedulerTick && idLead) {
    const det = await detectFormSumarRecebidoNoKommo(env, idLead, {
      minNoteAfterIso: row?.inscricao_form_recebido_at || null,
    })
    kommoFormDone = Boolean(det.detected)
    detectSource = det.source || det.reason || ''
    if (kommoFormDone) {
      console.log(
        `[inscricaoPostForm] scheduler lead=${idLead} formulario_detectado source=${detectSource} status_supabase=${status || 'n/a'}`,
      )
    }
  }

  const waitingForForm = [
    INSCRICAO_FORM_STATUS_AGUARDANDO,
    INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  ].includes(status)

  const trigger =
    shouldTriggerMatriculaPosForm(userMessage, status) ||
    (schedulerTick && status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO) ||
    (schedulerTick && kommoFormDone && waitingForForm)

  if (!trigger) return null

  if (idLead == null) {
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
        steps: [{ type: 'inscricao_form_complete', ok: false, code: 'LEAD_NOT_FOUND' }],
      }),
    }
  }

  return stepMatriculaPosForm(env, {
    telefone,
    idLead,
    executionId,
    model,
    pushName,
    t0,
    kommoFormDetected: kommoFormDone,
  })
}

/** Compat: agentRunner import antigo. */
export async function tryHandleInscricaoFormComplete(env, input) {
  return tryProcessInscricaoPostFormPipeline(env, input)
}

/** Liga o avanço pós-form no tick do scheduler (default: desligado). */
export function isInscricaoPostFormSchedulerEnabled(env = process.env) {
  return String(env?.INSCRICAO_POST_FORM_SCHEDULER_ENABLED ?? 'false').trim().toLowerCase() === 'true'
}

/**
 * Scheduler: detecta form preenchido via notas Kommo (Flow) ou status Supabase
 * e dispara salesbot 49813 sem depender de mensagem no buffer.
 * Desligado por padrão — defina INSCRICAO_POST_FORM_SCHEDULER_ENABLED=true para reativar.
 */
export async function tryAdvanceInscricaoPostFormScheduler(env, { telefone, leadId }) {
  if (!isInscricaoPostFormSchedulerEnabled(env)) {
    return null
  }
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
