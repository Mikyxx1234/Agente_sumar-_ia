/**
 * Pós Form Sumar (fluxo direto):
 *   formulário respondido → salesbot matrícula 49813 + pause IA
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  messageLooksLikeFormSumarResponse,
  messageLooksLikeFormFollowUp,
  messageSignalsFormSubmissionAck,
  buildInscricaoFormCompleteReply,
  matriculaPosFormAlreadyProcessed,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'
import { findLastFormularioSumSentMs, noteBlob, noteCreatedMs } from '../libShared/kommoFormNotes.js'
import { sendMessageWithNote } from './whatsappSender.js'
import { fetchLeadFormSnapshot, validateFormSnapshot } from './inscricaoKommoFields.js'
import {
  resolvePoloFromKommoSnapshot,
  matchPoloFromUserMessage,
  resolvePoloUnidadeCode,
  SUMARE_POLOS_EAD,
} from '../libShared/sumarePoloCatalog.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { findLeadByPhone, listLeadNotes, listLeadEvents } from './kommoClient.js'
import {
  updateDadosCliente,
  marcarClienteIA,
  getLeadIdByTelefone,
  normalizeTelefone,
  fetchDadosClienteByTelefone,
} from './dadosClienteStore.js'
import { DADOS_CLIENTE_INSCRICAO_SELECT } from './dadosClienteInscricaoFields.js'
import { isSumareCaptacaoEnabled } from './sumareCaptacaoClient.js'
import {
  leadHasPostFormRegistradoNote,
  leadHasPostFormRegistradoNoteSinceLastFormSend,
} from './postFormSendGuard.js'
import { getAgentQueueSessionCutoffIso } from './agentQueueSession.js'
import {
  runMatriculaCaptacaoAfterForm,
  shouldRunSalesbot49813,
} from './matriculaCaptacaoPipeline.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'
const MATRICULA_BOT_ID_DEFAULT = 49813

/** Claim em memória quando não há linha em dados_cliente_sum (form enviado só via Kommo). */
const matriculaClaimMem = new Map()

function matriculaClaimMemKey(telefone) {
  return normalizeTelefone(telefone)
}

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum',
  }
}

async function getClienteRow(env, telefone) {
  return fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_INSCRICAO_SELECT)
}

async function setFormStatus(env, telefone, status) {
  return updateDadosCliente(env, { telefone, fields: { [FORM_STATUS_FIELD]: status } })
}

/**
 * Claim atômico: marca concluído antes do salesbot 49813 — evita 5 disparos em réplicas paralelas.
 */
async function ensureClienteRowForMatricula(env, telefone, leadId) {
  let row = await getClienteRow(env, telefone)
  if (row?.id != null) return row
  if (leadId != null) {
    await marcarClienteIA(env, { telefone, idLead: leadId }).catch(() => {})
    row = await getClienteRow(env, telefone)
    if (row?.id != null) return row
  }
  return null
}

async function claimMatriculaPosFormExclusive(env, telefone, { leadId } = {}) {
  const { url, key, table } = getSupabaseCfg(env)
  const memKey = matriculaClaimMemKey(telefone)
  try {
    const existing = await getClienteRow(env, telefone)
    if (matriculaPosFormAlreadyProcessed(existing)) {
      return {
        claimed: false,
        reason: 'matricula_already_processed',
        status: existing?.[FORM_STATUS_FIELD],
      }
    }

    let rowId = existing?.id != null ? Number(existing.id) : NaN
    if (!Number.isFinite(rowId) || rowId <= 0) {
      await ensureClienteRowForMatricula(env, telefone, leadId)
      const again = await getClienteRow(env, telefone)
      rowId = again?.id != null ? Number(again.id) : NaN
    }

    if (!Number.isFinite(rowId) || rowId <= 0) {
      if (!url || !key) return { claimed: false, reason: 'no_supabase' }
      const prev = matriculaClaimMem.get(memKey)
      if (prev && Date.now() - prev.at < 120_000) {
        return { claimed: false, reason: 'memory_claim_busy' }
      }
      matriculaClaimMem.set(memKey, { at: Date.now(), leadId: leadId ?? null })
      console.log(`[inscricaoPostForm] claim memória telefone=${telefone} (sem dados_cliente_sum)`)
      return { claimed: true, reason: 'memory_claim_no_row' }
    }

    if (!url || !key) return { claimed: false, reason: 'no_supabase' }
    const waiting = [
      INSCRICAO_FORM_STATUS_AGUARDANDO,
      INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
    ].join(',')

    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?id=eq.${rowId}&${FORM_STATUS_FIELD}=in.(${waiting})&inscricao_form_recebido_at=is.null`,
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
      return { claimed: false, reason: `patch_${res.status}`, detail: errBody.slice(0, 200) }
    }
    const rows = await res.json()
    if (Array.isArray(rows) && rows.length === 1) {
      return { claimed: true, reason: 'claimed_waiting_status' }
    }
    const row = await getClienteRow(env, telefone)
    if (matriculaPosFormAlreadyProcessed(row)) {
      return { claimed: false, reason: 'matricula_already_processed', status: row?.[FORM_STATUS_FIELD] }
    }
    const st = row?.[FORM_STATUS_FIELD] ?? null
    if (st === INSCRICAO_FORM_STATUS_CONCLUIDO) {
      return { claimed: false, reason: 'already_completed', status: st }
    }
    if (!matriculaPosFormAlreadyProcessed(row)) {
      const prev = matriculaClaimMem.get(memKey)
      if (prev && Date.now() - prev.at < 120_000) {
        return { claimed: false, reason: 'memory_claim_busy' }
      }
      matriculaClaimMem.set(memKey, { at: Date.now(), leadId: leadId ?? null })
      console.log(
        `[inscricaoPostForm] claim memória telefone=${telefone} (status=${st || 'n/a'} sem patch aguardando)`,
      )
      return { claimed: true, reason: 'memory_claim_stale_status' }
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
  if (messageSignalsFormSubmissionAck(userMessage)) return true
  if (
    status === INSCRICAO_FORM_STATUS_AGUARDANDO ||
    status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO
  ) {
    return messageLooksLikeFormFollowUp(userMessage, { strictAwaitingForm: true })
  }
  return false
}

function eventCreatedMs(ev) {
  const c = ev?.created_at
  if (c == null) return 0
  if (typeof c === 'number') return c < 1e12 ? c * 1000 : c
  const t = Date.parse(c)
  return Number.isNaN(t) ? 0 : t
}

/**
 * O Flow do Form Sumar no WhatsApp costuma NÃO virar nota inbound com texto
 * ("Flow responses received" fica só no chat Amojo). Detectamos por:
 *   1) nota com texto de flow / respostas recebidas
 *   2) eventos custom_field_*_value_changed após Formulario_Sum
 *   3) snapshot do lead no Kommo com campos obrigatórios preenchidos
 */
export async function detectFormSumarRecebidoNoKommo(env, leadId, options = {}) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) return { detected: false, reason: 'invalid_lead' }

  const maxAgeH = Number(env.INSCRICAO_FORM_KOMMO_NOTE_MAX_AGE_H || 48)
  const maxAgeMs = (Number.isFinite(maxAgeH) && maxAgeH > 0 ? maxAgeH : 48) * 3600000
  const now = Date.now()
  const minNoteAfterMs = options.minNoteAfterIso ? Date.parse(options.minNoteAfterIso) : NaN

  const notesRes = await listLeadNotes(env, id, { limit: 60, order: 'desc' })
  const notes = notesRes.ok && Array.isArray(notesRes.notes) ? notesRes.notes : []
  const formSentMs = findLastFormularioSumSentMs(notes)
  const afterMs = Math.max(
    Number.isFinite(minNoteAfterMs) && !Number.isNaN(minNoteAfterMs) ? minNoteAfterMs : 0,
    formSentMs > 0 ? formSentMs - 60_000 : 0,
  )

  for (const n of notes) {
    const ts = noteCreatedMs(n)
    if (ts && now - ts > maxAgeMs) continue
    if (afterMs && ts && ts < afterMs) continue
    const blob = noteBlob(n)
    if (messageLooksLikeFormSumarResponse(blob)) {
      return { detected: true, source: 'kommo_note', sample: blob.slice(0, 120) }
    }
  }

  if (formSentMs > 0) {
    const fromTs = Math.max(0, Math.floor((afterMs || formSentMs) / 1000))
    const evRes = await listLeadEvents(env, id, { types: [], limit: 80, fromTs })
    if (evRes.ok && Array.isArray(evRes.events)) {
      let fieldChanges = 0
      for (const ev of evRes.events) {
        const ts = eventCreatedMs(ev)
        if (ts && ts < afterMs) continue
        const t = String(ev?.type || '').toLowerCase()
        if (/^custom_field_\d+_value_changed$/.test(t)) fieldChanges += 1
      }
      const minChanges = Number(env.INSCRICAO_FORM_KOMMO_FIELD_CHANGES_MIN)
      const need = Number.isFinite(minChanges) && minChanges > 0 ? Math.floor(minChanges) : 2
      if (fieldChanges >= need) {
        return {
          detected: true,
          source: 'kommo_field_events',
          sample: `${fieldChanges} alterações de campo após Formulario_Sum`,
        }
      }
    }

    const snapRes = await fetchLeadFormSnapshot(env, id)
    if (snapRes.ok && snapRes.snapshot) {
      const val = validateFormSnapshot(env, snapRes.snapshot)
      // No tick do scheduler: snapshot preenchido não significa "formulário
      // acabou de chegar" — senão bloqueia flush de mensagens novas (ex.: "olá").
      if (val.valid && !options.schedulerTick) {
        return {
          detected: true,
          source: 'kommo_snapshot',
          sample: `nome=${String(snapRes.snapshot.nome || '').slice(0, 40)} email=${String(snapRes.snapshot.email || '').slice(0, 40)}`,
        }
      }
    }
  }

  return { detected: false, reason: formSentMs > 0 ? 'not_found_after_form_sent' : 'no_formulario_sum_note' }
}

/**
 * Polo deve ter sido escolhido ANTES do formulário. Usa Supabase, card Kommo ou default env.
 */
async function preparePoloStepAfterForm(env, { telefone, leadId, pushName }) {
  const snapRes = leadId ? await fetchLeadFormSnapshot(env, leadId) : { ok: false }
  const snapshot = snapRes.ok ? snapRes.snapshot : {}

  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    `${DADOS_CLIENTE_INSCRICAO_SELECT},polo_inscricao_escolhido,captacao_unidade`,
  )
  const poloDb = String(row?.polo_inscricao_escolhido || '').trim()
  const unidadeDb = String(row?.captacao_unidade || '').trim()
  if (poloDb && unidadeDb) {
    const matched = matchPoloFromUserMessage(poloDb)
    return {
      askPolo: false,
      snapshotOverride: { ...snapshot, unidade: unidadeDb, polo_inscricao: poloDb },
      poloResolved: {
        polo: matched || { nome: poloDb, id: 'supabase' },
        unidade: unidadeDb,
        source: 'supabase_pre_form',
      },
    }
  }

  const resolved = resolvePoloFromKommoSnapshot(snapshot, env)
  if (resolved) {
    return {
      askPolo: false,
      snapshotOverride: {
        ...snapshot,
        unidade: resolved.unidade,
        polo_inscricao: resolved.polo.nome,
      },
      poloResolved: resolved,
    }
  }

  const poloId = String(env.INSCRICAO_DEFAULT_POLO_ID || 'pinheiros').trim()
  const matched = matchPoloFromUserMessage(poloId) || SUMARE_POLOS_EAD.find((p) => p.id === poloId)
  if (matched) {
    const unidade = resolvePoloUnidadeCode(matched.id, env)
    console.warn(
      `[inscricaoPostForm] lead=${leadId} polo ausente no pré-form — fallback ${matched.nome} (${unidade})`,
    )
    return {
      askPolo: false,
      snapshotOverride: { ...snapshot, unidade, polo_inscricao: matched.nome },
      poloResolved: { polo: matched, unidade, source: 'fallback_default_polo' },
    }
  }

  const nameBit = pushName ? `, ${String(pushName).split(/\s+/)[0]}` : ''
  return {
    askPolo: false,
    missingPolo: true,
    reply:
      `Obrigado${nameBit}! Recebemos seu formulário, mas não localizamos o polo de inscrição no cadastro. ` +
      `Um consultor da Faculdade Sumaré entrará em contato em breve para concluir sua matrícula.`,
  }
}

/**
 * Executa captação Sumaré + salesbot fallback + pause (após polo definido).
 * @returns {Promise<{ ok, reply, steps, toolCalls, ctxForm, skipSchedulerWhatsapp }>}
 */
export async function executeCaptacaoAfterFormResolved(env, ctx) {
  const { telefone, idLead, executionId, pushName, snapshotOverride } = ctx
  const steps = []
  const toolCalls = []
  let reply = buildInscricaoFormCompleteReply({ pushName, ok: false })
  let matriculaOk = false
  let ctxForm = 'completed'
  let skipSchedulerWhatsapp = false
  let contratoWhatsappSent = false

  if (isSumareCaptacaoEnabled(env)) {
    const cap = await runMatriculaCaptacaoAfterForm(env, {
      telefone,
      leadId: idLead,
      pushName,
      executionId,
      snapshotOverride,
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
      if (cap.whatsappOk) {
        skipSchedulerWhatsapp = true
        contratoWhatsappSent = true
      }
      matriculaClaimMem.delete(matriculaClaimMemKey(telefone))
      toolCalls.push({
        tool: 'sumare_captacao_contrato',
        args: { telefone, id_lead: idLead, candidato: cap.candidatoId },
        result: `Link contrato enviado: ${cap.contractUrl}`,
        ok: Boolean(cap.whatsappOk),
      })
    } else if (cap.skipped) {
      ctxForm = INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
      contratoWhatsappSent = true
      skipSchedulerWhatsapp = true
    } else if (!cap.skipped && !cap.ok) {
      const missing = Array.isArray(cap.missing) ? cap.missing.join(', ') : ''
      console.error(
        `[inscricaoPostForm] captação falhou lead=${idLead} code=${cap.code} missing=${missing} err=${String(cap.error || '').slice(0, 800)}`,
      )
      const firstName = pushName ? `, ${String(pushName).split(/\s+/)[0]}` : ''
      if (missing.includes('curso') || cap.code === 'MISSING_FIELDS') {
        reply =
          `Obrigado${firstName}! Recebemos seu formulário. O curso informado ainda não está disponível para inscrição automática no momento. ` +
          `Um consultor da Faculdade Sumaré entrará em contato em breve.`
      } else {
        reply = buildInscricaoFormCompleteReply({ pushName, ok: false })
      }
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

  if (ctxForm === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) {
    // Após enviar o link, IA generativa fica em pausa. tryHandleMatriculaAceitePagamentoFlow
    // roda ANTES do gate ia_paused (agentRunner), garantindo:
    //   - reenvio canônico do link se o lead pedir
    //   - recebimento e validação do comprovante de pagamento
    // Qualquer outra mensagem é ignorada — candidato lê o contrato, aceita e paga
    // pelo portal Sumaré; só volta IA quando consultor liberar.
    const pauseRes = await pauseAtendimentoIa(env, telefone)
    steps.unshift({ type: 'ia_paused', ok: pauseRes.ok, reason: 'aguardando_aceite_contrato' })
  } else {
    const pauseRes = await pauseAtendimentoIa(env, telefone)
    steps.unshift({ type: 'ia_paused', ok: pauseRes.ok })
    await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_CONCLUIDO).catch(() => {})
    ctxForm = INSCRICAO_FORM_STATUS_CONCLUIDO
  }

  return {
    ok: matriculaOk || ctxForm === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
    matriculaOk,
    reply,
    steps,
    toolCalls,
    ctxForm,
    skipSchedulerWhatsapp,
    contratoWhatsappSent,
  }
}

/**
 * Form preenchido → pergunta polo (se necessário) → API Captação → salesbot 49813 fallback.
 */
async function stepMatriculaPosForm(env, ctx) {
  const { telefone, idLead, executionId, model, pushName, t0, kommoFormDetected } = ctx

  if (idLead != null && (await leadHasPostFormRegistradoNoteSinceLastFormSend(env, idLead))) {
    console.log(`[inscricaoPostForm] lead=${idLead} skip matricula_pos_form (nota pós-form após último Formulario_Sum)`)
    return { handled: false, reason: 'kommo_post_form_note_exists' }
  }

  const poloPrep = await preparePoloStepAfterForm(env, { telefone, leadId: idLead, pushName })

  if (poloPrep?.missingPolo) {
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: poloPrep.reply,
        steps: [{ type: 'polo_ausente_pos_form', ok: false }],
        ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO },
      }),
    }
  }

  const claim = await claimMatriculaPosFormExclusive(env, telefone, { leadId: idLead })
  if (!claim.claimed) {
    console.log(
      `[inscricaoPostForm] lead=${idLead} matricula_pos_form skip claim=${claim.reason} status=${claim.status || 'n/a'}`,
    )
    if (kommoFormDetected) {
      const pushFirst = pushName ? String(pushName).split(/\s+/)[0] : ''
      const nameBit = pushFirst ? `, ${pushFirst}` : ''
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply:
            `Obrigado${nameBit}! Recebemos seu formulário e já estamos processando sua inscrição no sistema. ` +
            `Em instantes você recebe aqui o link para aceitar o contrato e concluir o pagamento.`,
          steps: [{ type: 'matricula_claim_deferred', ok: false, reason: claim.reason }],
          ctxSnapshot: {
            inscricaoForm: claim.status || INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
            kommoFormDetected: true,
          },
        }),
      }
    }
    return { handled: false, reason: claim.reason || 'matricula_claim_failed' }
  }

  const capOut = await executeCaptacaoAfterFormResolved(env, {
    telefone,
    idLead,
    executionId,
    model,
    pushName,
    t0,
    snapshotOverride: poloPrep?.snapshotOverride,
  })

  await updateDadosCliente(env, {
    telefone,
    fields: { inscricao_form_recebido_at: new Date().toISOString() },
  }).catch(() => {})

  const steps = capOut.steps || []
  if (poloPrep?.poloResolved) {
    steps.unshift({
      type: 'polo_kommo_card',
      polo: poloPrep.poloResolved.polo?.nome,
      unidade: poloPrep.poloResolved.unidade,
      source: poloPrep.poloResolved.source,
    })
  }

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply: capOut.reply,
      steps,
      toolCalls: capOut.toolCalls,
      ctxSnapshot: {
        inscricaoForm: capOut.ctxForm,
        iaPaused: capOut.ctxForm !== INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
        sumareCaptacao: isSumareCaptacaoEnabled(env),
        contratoWhatsappSent: Boolean(capOut.contratoWhatsappSent),
        contratoLinkSent: Boolean(capOut.contratoWhatsappSent),
        skipSchedulerWhatsapp: capOut.skipSchedulerWhatsapp,
        kommoFormDetected,
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

  if (matriculaPosFormAlreadyProcessed(row)) {
    console.log(
      `[inscricaoPostForm] skip telefone=${telefone} matricula_ja_processada status=${status || 'n/a'} recebido_at=${row?.inscricao_form_recebido_at || 'n/a'}`,
    )
    return null
  }

  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM) return null
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_POLO) return null
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO) return null
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) return null
  if (status === INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO) return null

  const idLead = await resolveLeadId(env, telefone, leadIdHint)

  if (
    idLead != null &&
    !messageSignalsFormSubmissionAck(userMessage) &&
    (await leadHasPostFormRegistradoNoteSinceLastFormSend(env, idLead))
  ) {
    console.log(`[inscricaoPostForm] lead=${idLead} skip pipeline (nota pós-form após último Formulario_Sum)`)
    return null
  }

  const waitingForForm = [
    INSCRICAO_FORM_STATUS_AGUARDANDO,
    INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  ].includes(status)

  let kommoFormDone = false
  let detectSource = ''
  const shouldScanKommoNotes =
    idLead &&
    (schedulerTick ||
      waitingForForm ||
      messageSignalsFormSubmissionAck(userMessage))

  if (shouldScanKommoNotes) {
    const sessionCutoff = getAgentQueueSessionCutoffIso(idLead)
    const recebidoAt = row?.inscricao_form_recebido_at || null
    const minNoteAfterIso =
      recebidoAt && sessionCutoff
        ? Date.parse(recebidoAt) >= Date.parse(sessionCutoff)
          ? recebidoAt
          : sessionCutoff
        : recebidoAt || sessionCutoff || null
    const det = await detectFormSumarRecebidoNoKommo(env, idLead, {
      minNoteAfterIso,
    })
    kommoFormDone = Boolean(det.detected)
    detectSource = det.source || det.reason || ''
    if (kommoFormDone) {
      console.log(
        `[inscricaoPostForm] lead=${idLead} formulario_detectado source=${detectSource} scheduler=${Boolean(schedulerTick)} status=${status || 'n/a'}`,
      )
    }
  }

  const trigger =
    shouldTriggerMatriculaPosForm(userMessage, status) ||
    (schedulerTick && status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO) ||
    kommoFormDone

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

/** Liga o avanço pós-form legado no tick (extra além da detecção Kommo). */
export function isInscricaoPostFormSchedulerEnabled(env = process.env) {
  return String(env?.INSCRICAO_POST_FORM_SCHEDULER_ENABLED ?? 'false').trim().toLowerCase() === 'true'
}

/**
 * Scheduler: detecta formulário preenchido no Kommo (campos/eventos) mesmo sem
 * "Flow responses received" no buffer — roda após cada sync do poll.
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
