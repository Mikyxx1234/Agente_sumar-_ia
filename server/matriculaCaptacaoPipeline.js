/**
 * Pós-formulário Kommo → API Captação Sumaré → WhatsApp com link do contrato.
 *
 * Acionado quando SUMARE_CAPTACAO_ENABLED=true e o formulário foi preenchido.
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  buildContratoAceiteLinkReply,
} from '../libShared/inscricaoFormHeuristics.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import { updateDadosCliente, normalizeTelefone } from './dadosClienteStore.js'
import { sendMessageWithNote } from './whatsappSender.js'
import { createLeadNote } from './kommoClient.js'
import { isSumareCaptacaoEnabled, runCaptacaoContratoWorkflow } from './sumareCaptacaoClient.js'

const DEDUPE_MS = 6 * 60 * 60 * 1000
const _linkSentMemory = new Map()

function shouldRunSalesbot49813(env) {
  return ['true', '1', 'yes'].includes(
    String(env.SUMARE_CAPTACAO_RUN_SALESBOT_49813 || 'false').trim().toLowerCase(),
  )
}

async function getCaptacaoDedupe(env, telefone) {
  const fone = normalizeTelefone(telefone)
  if (!fone) return { skip: false }
  const mem = _linkSentMemory.get(fone)
  if (mem && Date.now() - mem < DEDUPE_MS) {
    return { skip: true, reason: 'memory_dedupe' }
  }
  const { url, key, table } = {
    url: (env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente',
  }
  if (!url || !key) return { skip: false }
  try {
    const enc = encodeURIComponent(fone)
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?telefone=eq.${enc}&select=captacao_contrato_link_at,captacao_candidato_id&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    )
    if (!res.ok) return { skip: false }
    const rows = await res.json()
    const row = rows?.[0]
    if (row?.captacao_contrato_link_at) {
      const ts = Date.parse(row.captacao_contrato_link_at)
      if (!Number.isNaN(ts) && Date.now() - ts < DEDUPE_MS) {
        return { skip: true, reason: 'supabase_dedupe', candidatoId: row.captacao_candidato_id }
      }
    }
  } catch {
    /* ignore */
  }
  return { skip: false }
}

async function persistCaptacaoResult(env, telefone, { candidatoId, contractUrl }) {
  const fields = {
    captacao_candidato_id: String(candidatoId),
    captacao_contrato_link: contractUrl,
    captacao_contrato_link_at: new Date().toISOString(),
    inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
    inscricao_form_recebido_at: new Date().toISOString(),
  }
  let upd = await updateDadosCliente(env, { telefone, fields })
  if (!upd.ok && upd.status === 400) {
    upd = await updateDadosCliente(env, {
      telefone,
      fields: {
        inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
        inscricao_form_recebido_at: new Date().toISOString(),
      },
    })
  }
  const fone = normalizeTelefone(telefone)
  if (fone) _linkSentMemory.set(fone, Date.now())
  return upd
}

/**
 * Executa inscrição Sumaré e envia link do contrato por WhatsApp.
 *
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reply?: string, contractUrl?: string, steps?: object[], error?: string }>}
 */
export async function runMatriculaCaptacaoAfterForm(env, ctx) {
  const { telefone, leadId, pushName, executionId } = ctx
  if (!isSumareCaptacaoEnabled(env)) {
    return { ok: false, skipped: true, reason: 'captacao_disabled' }
  }

  const dedupe = await getCaptacaoDedupe(env, telefone)
  if (dedupe.skip) {
    console.log(
      `[matriculaCaptacao] lead=${leadId} skip link (${dedupe.reason}) candidato=${dedupe.candidatoId || 'n/a'}`,
    )
    return { ok: true, skipped: true, reason: dedupe.reason }
  }

  const snapRes = await fetchLeadFormSnapshot(env, leadId)
  if (!snapRes.ok || !snapRes.snapshot) {
    return {
      ok: false,
      code: 'KOMMO_SNAPSHOT_FAILED',
      error: snapRes.error || 'Não foi possível ler dados do formulário no Kommo',
    }
  }

  const workflow = await runCaptacaoContratoWorkflow(env, {
    snapshot: snapRes.snapshot,
    telefone,
  })

  if (!workflow.ok) {
    console.warn(
      `[matriculaCaptacao] lead=${leadId} falha captacao: ${workflow.code} ${workflow.error}`,
    )
    return {
      ok: false,
      code: workflow.code,
      error: workflow.error,
      missing: workflow.missing,
      steps: workflow.steps,
    }
  }

  const { candidatoId, contractUrl } = workflow
  await persistCaptacaoResult(env, telefone, { candidatoId, contractUrl })

  const reply = buildContratoAceiteLinkReply({ pushName, contractUrl })
  const sendRes = await sendMessageWithNote(env, {
    telefone,
    text: reply,
    leadId,
    executionId,
  })

  if (leadId) {
    await createLeadNote(
      env,
      leadId,
      `Inscrição Sumaré (candidato ${candidatoId}) — link contrato enviado por WhatsApp: ${contractUrl}`,
    ).catch(() => {})
  }

  console.log(
    `[matriculaCaptacao] lead=${leadId} candidato=${candidatoId} whatsapp_ok=${sendRes?.ok} url=${contractUrl.slice(0, 80)}`,
  )

  return {
    ok: true,
    candidatoId,
    contractUrl,
    reply,
    whatsappOk: Boolean(sendRes?.ok),
    steps: workflow.steps,
    runSalesbot49813: shouldRunSalesbot49813(env),
  }
}

export { shouldRunSalesbot49813, INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE, INSCRICAO_FORM_STATUS_CONCLUIDO }
