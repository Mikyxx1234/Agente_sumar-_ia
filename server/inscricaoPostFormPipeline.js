/**
 * Pós Form Sumar (fluxo direto):
 *   formulário respondido → salesbot matrícula 49813 + pause IA
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  messageLooksLikeFormSumarResponse,
  messageLooksLikeFormFollowUp,
  buildInscricaoFormCompleteReply,
} from '../libShared/inscricaoFormHeuristics.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { findLeadByPhone, listLeadNotes } from './kommoClient.js'
import { updateDadosCliente, getLeadIdByTelefone, normalizeTelefone } from './dadosClienteStore.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'
const MATRICULA_BOT_ID_DEFAULT = 49813

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente',
  }
}

async function getClienteRow(env, telefone) {
  const { url, key, table } = getSupabaseCfg(env)
  if (!url || !key) return null
  const fone = normalizeTelefone(telefone)
  if (!fone) return null
  try {
    const enc = encodeURIComponent(fone)
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?telefone=eq.${enc}&select=${FORM_STATUS_FIELD},id_lead&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    )
    if (!res.ok) return null
    const rows = await res.json()
    return rows?.[0] || null
  } catch {
    return null
  }
}

async function setFormStatus(env, telefone, status) {
  return updateDadosCliente(env, { telefone, fields: { [FORM_STATUS_FIELD]: status } })
}

/**
 * Claim atômico: marca concluído antes do salesbot 49813 — evita 5 disparos em réplicas paralelas.
 */
async function claimMatriculaPosFormExclusive(env, telefone) {
  const { url, key, table } = getSupabaseCfg(env)
  if (!url || !key) return { claimed: true, reason: 'no_supabase' }
  const fone = normalizeTelefone(telefone)
  if (!fone) return { claimed: false, reason: 'invalid_phone' }
  const waiting = [
    INSCRICAO_FORM_STATUS_AGUARDANDO,
    INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  ].join(',')
  try {
    const enc = encodeURIComponent(fone)
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?telefone=eq.${enc}&${FORM_STATUS_FIELD}=in.(${waiting})`,
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
          `[inscricaoPostForm] claim patch_400 telefone=${fone} — confira coluna ${FORM_STATUS_FIELD} em ${table}. ${errBody.slice(0, 200)}`,
        )
      }
      return { claimed: false, reason: `patch_${res.status}`, detail: errBody.slice(0, 200) }
    }
    const rows = await res.json()
    if (Array.isArray(rows) && rows.length > 0) {
      return { claimed: true, reason: 'claimed_waiting_status' }
    }
    const resNull = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?telefone=eq.${enc}&${FORM_STATUS_FIELD}=is.null`,
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
    if (resNull.ok) {
      const rowsNull = await resNull.json()
      if (Array.isArray(rowsNull) && rowsNull.length > 0) {
        return { claimed: true, reason: 'claimed_null_status' }
      }
    }
    const row = await getClienteRow(env, telefone)
    const st = row?.[FORM_STATUS_FIELD] ?? null
    if (st === INSCRICAO_FORM_STATUS_CONCLUIDO) {
      return { claimed: false, reason: 'already_completed', status: st }
    }
    return { claimed: false, reason: 'no_waiting_row', status: st }
  } catch (err) {
    return { claimed: true, reason: `claim_error_${err.message}` }
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
    return messageLooksLikeFormFollowUp(userMessage)
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
export async function detectFormSumarRecebidoNoKommo(env, leadId) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) return { detected: false, reason: 'invalid_lead' }

  const maxAgeH = Number(env.INSCRICAO_FORM_KOMMO_NOTE_MAX_AGE_H || 48)
  const maxAgeMs = (Number.isFinite(maxAgeH) && maxAgeH > 0 ? maxAgeH : 48) * 3600000
  const now = Date.now()

  const notesRes = await listLeadNotes(env, id, { limit: 50, order: 'desc' })
  if (notesRes.ok && Array.isArray(notesRes.notes)) {
    for (const n of notesRes.notes) {
      const created = n?.created_at ?? n?.date_create
      if (created) {
        const ts = Date.parse(created)
        if (!Number.isNaN(ts) && now - ts > maxAgeMs) continue
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
    if (claim.reason === 'already_completed') {
      return { handled: false, reason: 'matricula_already_claimed' }
    }
    const proceedWithoutClaim =
      kommoFormDetected &&
      (claim.reason === 'no_waiting_row' || String(claim.reason || '').startsWith('patch_'))
    if (!proceedWithoutClaim) {
      console.log(
        `[inscricaoPostForm] lead=${idLead} matricula_pos_form skip claim=${claim.reason} status=${claim.status || 'n/a'}`,
      )
      return { handled: false, reason: 'matricula_already_claimed' }
    }
    console.warn(
      `[inscricaoPostForm] lead=${idLead} matricula_pos_form sem claim Supabase (${claim.reason}) — form detectado no Kommo, disparando salesbot`,
    )
  }

  const [salesbotRes, pauseRes] = await Promise.all([
    runKommoSalesbot(env, idLead, 'matricula_pos_form', {
      executionId,
      note: `Form Sumar recebido — salesbot matrícula ${MATRICULA_BOT_ID_DEFAULT} (agente IA) — ${executionId || ''}`.trim(),
    }),
    pauseAtendimentoIa(env, telefone),
  ])

  const matriculaOk = Boolean(salesbotRes.ok && !salesbotRes.skipped)
  if (matriculaOk) {
    await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_CONCLUIDO).catch(() => {})
  }
  const reply = buildInscricaoFormCompleteReply({ pushName, ok: matriculaOk })

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
          ok: matriculaOk,
          bot_id: salesbotRes.botId,
          pause_ok: pauseRes.ok,
        },
      ],
      toolCalls: [
        {
          tool: 'matricula_pos_form',
          args: { telefone, id_lead: idLead },
          result: matriculaOk ? `Salesbot ${salesbotRes.botId} disparado` : salesbotRes.text || 'falha',
          ok: matriculaOk,
        },
      ],
      ctxSnapshot: {
        inscricaoForm: 'completed',
        salesbotId: salesbotRes.botId,
        iaPaused: true,
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

  const idLead = await resolveLeadId(env, telefone, leadIdHint)

  let kommoFormDone = false
  let detectSource = ''
  if (schedulerTick && idLead) {
    const det = await detectFormSumarRecebidoNoKommo(env, idLead)
    kommoFormDone = Boolean(det.detected)
    detectSource = det.source || det.reason || ''
    if (kommoFormDone) {
      console.log(
        `[inscricaoPostForm] scheduler lead=${idLead} formulario_detectado source=${detectSource} status_supabase=${status || 'n/a'}`,
      )
    }
  }

  const trigger =
    shouldTriggerMatriculaPosForm(userMessage, status) ||
    (schedulerTick &&
      kommoFormDone &&
      status !== INSCRICAO_FORM_STATUS_CONCLUIDO) ||
    (schedulerTick && status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO)

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

/**
 * Scheduler: detecta form preenchido via notas Kommo (Flow) ou status Supabase
 * e dispara salesbot 49813 sem depender de mensagem no buffer.
 */
export async function tryAdvanceInscricaoPostFormScheduler(env, { telefone, leadId }) {
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
