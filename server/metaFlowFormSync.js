/**
 * Sincroniza o retorno do Meta Flow (formulário de inscrição) com o card do
 * Kommo — assumindo a função que o n8n fazia (`log_inscricao_feita_sum`):
 *   nodes "Update leads2" (campos personalizados + move p/ inscrição) e
 *   "Create new notes" (nota de auditoria com os dados).
 *
 * Depois disso, o pipeline pós-form existente (inscricaoPostFormPipeline.js) lê
 * o card já preenchido via fetchLeadFormSnapshot e segue para a matrícula.
 *
 * Campos personalizados do card (mesmos IDs usados pelo n8n; sobrescrevíveis por env):
 *   1475361 nome (text) | 1475363 cpf (numeric) | 1475397 telefone (text)
 *   1475467 data nascimento (text) | 1475971 sexo (select)
 * O e-mail vai SÓ na nota (o n8n não gravava e-mail no card) — o snapshot do
 * agente já lê e-mail da nota via enrichSnapshotFromFormNote.
 */

import { createLeadNote } from './kommoClient.js'
import { AGENT_FUNNEL_PIPELINE_ID, AGENT_FUNNEL_STATUS_INSCRICAO } from './kommoAgentFunnelGate.js'

const DEFAULT_FIELD_IDS = {
  nome: 1475361,
  cpf: 1475363,
  telefone: 1475397,
  data_nasc: 1475467,
  sexo: 1475971,
}

// Evita reprocessar (PATCH + nota duplicada) o mesmo formulário em retries/turnos.
const SYNC_DEDUPE_TTL_MS = 10 * 60 * 1000
/** @type {Map<string, number>} */
const recentSyncs = new Map()

function fieldId(env, slot) {
  const fromEnv = Number(env[`KOMMO_FIELD_FORM_${slot.toUpperCase()}_ID`])
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return DEFAULT_FIELD_IDS[slot]
}

function targetFunnel(env) {
  const pipe = Number(env.AGENT_FUNNEL_PIPELINE_ID) || AGENT_FUNNEL_PIPELINE_ID
  const status = Number(env.AGENT_FUNNEL_STATUS_INSCRICAO) || AGENT_FUNNEL_STATUS_INSCRICAO
  return { pipelineId: pipe, statusId: status }
}

function buildCustomFields(env, parsed) {
  const cf = []
  if (parsed.nome_completo) cf.push({ field_id: fieldId(env, 'nome'), values: [{ value: parsed.nome_completo }] })
  if (parsed.cpf_digits) cf.push({ field_id: fieldId(env, 'cpf'), values: [{ value: parsed.cpf_digits }] })
  if (parsed.telefone_normalizado)
    cf.push({ field_id: fieldId(env, 'telefone'), values: [{ value: parsed.telefone_normalizado }] })
  if (parsed.data_nascimento)
    cf.push({ field_id: fieldId(env, 'data_nasc'), values: [{ value: parsed.data_nascimento }] })
  // Campo select: a API casa pelo texto da opção (ex.: "Masculino").
  if (parsed.sexo) cf.push({ field_id: fieldId(env, 'sexo'), values: [{ value: parsed.sexo }] })
  return cf
}

function buildAuditNoteText(parsed, executionId) {
  const v = (x) => (x == null || x === '' ? '' : String(x))
  return (
    `CPF: ${v(parsed.cpf)}\n` +
    `DATA DE NASCIMENTO: ${v(parsed.data_nascimento)}\n` +
    `NOME: ${v(parsed.nome_completo)}\n` +
    `EMAIL: ${v(parsed.email)}\n` +
    `TELEFONE INSCRICAO:${v(parsed.telefone_normalizado)} \n` +
    `SEXO: ${v(parsed.sexo)} - ${v(executionId)}`
  )
}

async function patchLead(env, leadId, body) {
  const base = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = env.KOMMO_ACCESS_TOKEN || ''
  if (!base || !token) return { ok: false, code: 'KOMMO_NOT_CONFIGURED' }
  try {
    const res = await fetch(`${base}/api/v4/leads/${leadId}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    const text = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, body: text.slice(0, 300) }
  } catch (err) {
    return { ok: false, code: 'FETCH_FAILED', error: err.message }
  }
}

/**
 * Grava os dados do formulário no card do Kommo (campos + move p/ inscrição) e
 * cria a nota de auditoria.
 *
 * @param {Record<string,string>} env
 * @param {{ leadId:number, parsed:object, executionId?:string, moveStatus?:boolean }} input
 * @returns {Promise<{ok:boolean, cardOk?:boolean, noteOk?:boolean, statusMoved?:boolean, skipped?:string, code?:string}>}
 */
export async function applyMetaFlowFormToKommo(env, { leadId, parsed, executionId, moveStatus = true }) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) return { ok: false, code: 'LEAD_ID_INVALIDO' }
  if (!parsed?.ok) return { ok: false, code: 'PARSED_INVALIDO' }

  const dedupeKey = `${id}:${parsed.cpf_digits || parsed.telefone_normalizado || ''}`
  const last = recentSyncs.get(dedupeKey)
  if (last && Date.now() - last < SYNC_DEDUPE_TTL_MS) {
    return { ok: true, skipped: 'recente' }
  }

  const customFields = buildCustomFields(env, parsed)
  const { pipelineId, statusId } = targetFunnel(env)

  const body = {}
  if (customFields.length) body.custom_fields_values = customFields
  if (moveStatus) {
    body.pipeline_id = pipelineId
    body.status_id = statusId
  }

  let cardOk = true
  if (Object.keys(body).length) {
    const res = await patchLead(env, id, body)
    cardOk = res.ok
    if (!res.ok) {
      console.warn(`[metaFlowFormSync] PATCH lead=${id} falhou status=${res.status} body=${res.body || res.error || ''}`)
    }
  }

  let noteOk = false
  try {
    const noteRes = await createLeadNote(env, id, buildAuditNoteText(parsed, executionId))
    noteOk = Boolean(noteRes?.ok)
  } catch (err) {
    console.warn(`[metaFlowFormSync] nota lead=${id} falhou: ${err.message}`)
  }

  if (cardOk) recentSyncs.set(dedupeKey, Date.now())

  return {
    ok: cardOk,
    cardOk,
    noteOk,
    statusMoved: Boolean(moveStatus && cardOk),
    fieldsWritten: customFields.length,
  }
}
