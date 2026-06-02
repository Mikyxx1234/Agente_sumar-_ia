/**
 * Leitura e validação dos campos do lead no Kommo após o Form Sumar.
 */

import { listLeadCustomFields, listLeadNotes } from './kommoClient.js'
import { parseFormDataNoteFields } from '../libShared/inscricaoFormHeuristics.js'

const KOMMO_FIELD_NOME = 304628

const FIELD_ALIASES = {
  email: ['e-mail', 'email', 'e_mail', 'sum_email', 'sum e-mail', 'sum e mail'],
  cpf: ['cpf', 'documento', 'cnpj/cpf', 'sum_cpf', 'sum cpf'],
  cursoInscricao: [
    'curso inscrição',
    'curso da inscrição',
    'curso_inscricao',
    'curso da inscricao',
    'sum_curso',
    'sum curso',
    'código curso',
    'codigo curso',
  ],
  tipoInscricao: ['tipo inscrição', 'tipo de ingresso', 'tipo_inscricao', 'tipo de inscrição'],
  poloInscricao: ['polo inscrição', 'polo da inscrição', 'polo_inscricao', 'sum_polo', 'sum polo'],
  dataNasc: [
    'data nascimento',
    'data de nascimento',
    'data_nasc',
    'nascimento',
    'dt nasc',
    'sum_data nascimento',
    'sum data nascimento',
    'sum_data_nascimento',
  ],
  sexo: ['sexo', 'gênero', 'genero'],
  unidade: ['unidade', 'polo', 'campus', 'unidade inscrição'],
  turno: ['turno', 'modalidade'],
  modalidade: ['sum_modalidade', 'sum modalidade', 'modalidade'],
  statusInscricao: [
    'sum_status_inscricao',
    'sum status inscricao',
    'sum_status inscrição',
    'sum status inscrição',
    'status inscrição',
    'status inscricao',
  ],
}

function isCampoAusente(val) {
  const t = String(val ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!t) return true
  if (/^n[ãa]o informado\.?$/i.test(t)) return true
  if (/^n\/a$/i.test(t)) return true
  if (t === '-' || t === '—') return true
  return false
}

function pickCustomFieldValue(fields, fieldId) {
  if (!Array.isArray(fields) || !fieldId) return ''
  const f = fields.find((x) => Number(x.field_id) === Number(fieldId))
  if (!f?.values?.length) return ''
  const v = f.values[0]
  if (v?.value != null && String(v.value).trim()) return String(v.value).trim()
  if (v?.enum_id != null && Array.isArray(f.enums)) {
    const en = f.enums.find((e) => e.id === v.enum_id)
    if (en?.value) return String(en.value).trim()
  }
  return ''
}

function pickByAliases(fields, fieldsByName, aliases) {
  if (!fieldsByName) return ''
  for (const a of aliases) {
    const def = fieldsByName.get(String(a).trim().toLowerCase())
    if (!def) continue
    const val = pickCustomFieldValue(fields, def.id)
    if (!isCampoAusente(val)) return val
  }
  return ''
}

async function kommoGetLead(env, leadId) {
  const base = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = env.KOMMO_ACCESS_TOKEN || ''
  if (!base || !token) return null
  const res = await fetch(`${base}/api/v4/leads/${leadId}?with=contacts`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  try {
    return await res.json()
  } catch {
    return null
  }
}

/**
 * @returns {Promise<{ ok: boolean, lead?: object, fieldsByName?: Map, error?: string }>}
 */
export async function fetchLeadFormSnapshot(env, leadId) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: 'lead_id_invalido' }
  }
  const [lead, fieldsLookup] = await Promise.all([
    kommoGetLead(env, id),
    listLeadCustomFields(env).catch(() => ({ ok: false })),
  ])
  if (!lead?.id) return { ok: false, error: 'lead_nao_encontrado' }
  const fieldsByName = fieldsLookup.ok ? fieldsLookup.byName : null
  const custom = lead.custom_fields_values || []
  const contact = lead._embedded?.contacts?.[0]

  const nomeLead = String(lead.name || '').trim()
  const nomeSum = pickByAliases(custom, fieldsByName, ['sum_nome', 'sum nome', 'nome completo'])
  const nomeField =
    (!isCampoAusente(nomeSum) ? nomeSum : '') ||
    pickCustomFieldValue(custom, KOMMO_FIELD_NOME) ||
    pickCustomFieldValue(contact?.custom_fields_values, KOMMO_FIELD_NOME) ||
    pickByAliases(contact?.custom_fields_values, fieldsByName, ['sum_nome', 'sum nome'])
  const email =
    pickByAliases(custom, fieldsByName, FIELD_ALIASES.email) ||
    pickByAliases(contact?.custom_fields_values, fieldsByName, FIELD_ALIASES.email)
  const cpf =
    pickByAliases(custom, fieldsByName, FIELD_ALIASES.cpf) ||
    pickByAliases(contact?.custom_fields_values, fieldsByName, FIELD_ALIASES.cpf)
  const cursoInscricao = pickByAliases(custom, fieldsByName, FIELD_ALIASES.cursoInscricao)
  const tipoInscricao = pickByAliases(custom, fieldsByName, FIELD_ALIASES.tipoInscricao)
  const poloInscricao = pickByAliases(custom, fieldsByName, FIELD_ALIASES.poloInscricao)
  const dataNasc = pickByAliases(custom, fieldsByName, FIELD_ALIASES.dataNasc)
  const sexo = pickByAliases(custom, fieldsByName, FIELD_ALIASES.sexo)
  const unidade = pickByAliases(custom, fieldsByName, FIELD_ALIASES.unidade)
  const turno = pickByAliases(custom, fieldsByName, FIELD_ALIASES.turno)
  const modalidade = pickByAliases(custom, fieldsByName, FIELD_ALIASES.modalidade)
  const statusInscricao = pickByAliases(custom, fieldsByName, FIELD_ALIASES.statusInscricao)

  const snapshot = {
    nome: !isCampoAusente(nomeField) ? nomeField : nomeLead,
    email,
    cpf,
    curso_inscricao: cursoInscricao,
    tipo_inscricao: tipoInscricao,
    polo_inscricao: poloInscricao,
    data_nasc: dataNasc,
    sexo,
    unidade,
    turno,
    modalidade,
    status_inscricao: statusInscricao,
    responsible_user_id: Number(lead.responsible_user_id) || 0,
    status_id: Number(lead.status_id) || 0,
    pipeline_id: Number(lead.pipeline_id) || 0,
  }

  const enriched = await enrichSnapshotFromFormNote(env, id, snapshot)
  return { ok: true, lead, snapshot: enriched }
}

function noteText(n) {
  const p = n?.params || {}
  return String(p.text || p.message || '').trim()
}

/**
 * Preenche campos vazios do snapshot a partir da última nota de dados do
 * formulário (o n8n grava esses dados na nota; às vezes não replica em TODOS
 * os campos personalizados — ex.: o e-mail vai só na nota). Só preenche o que
 * está ausente; nunca sobrescreve um valor já presente no campo do Kommo.
 */
async function enrichSnapshotFromFormNote(env, leadId, snapshot) {
  const keys = ['nome', 'email', 'cpf', 'data_nasc', 'sexo']
  const missing = keys.filter((k) => isCampoAusente(snapshot?.[k]))
  if (missing.length === 0) return snapshot
  let notes = []
  try {
    const res = await listLeadNotes(env, leadId, { limit: 30, order: 'desc' })
    notes = res?.ok && Array.isArray(res.notes) ? res.notes : []
  } catch {
    return snapshot
  }
  for (const n of notes) {
    const fields = parseFormDataNoteFields(noteText(n))
    if (!fields || Object.keys(fields).length === 0) continue
    const merged = { ...snapshot }
    for (const k of keys) {
      if (isCampoAusente(merged[k]) && fields[k]) merged[k] = fields[k]
    }
    return merged
  }
  return snapshot
}

/**
 * Campos obrigatórios após o Flow (configurável via CSV de chaves).
 * Chaves: nome, email, cpf, curso_inscricao, tipo_inscricao, polo_inscricao
 */
export function getRequiredFormFieldKeys(env) {
  const raw = String(
    env.INSCRICAO_FORM_REQUIRED_FIELDS || 'nome,email,cpf,curso_inscricao',
  )
    .trim()
    .toLowerCase()
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const FIELD_LABELS = {
  nome: 'Nome completo',
  email: 'E-mail',
  cpf: 'CPF',
  curso_inscricao: 'Curso da inscrição',
  tipo_inscricao: 'Tipo de ingresso',
  polo_inscricao: 'Polo',
}

/**
 * @param {Record<string,string>} env
 * @param {{ nome, email, cpf, curso_inscricao, tipo_inscricao, polo_inscricao }} snapshot
 */
function isValidEmailShape(val) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val || '').trim())
}

export function validateFormSnapshot(env, snapshot) {
  const required = getRequiredFormFieldKeys(env)
  const missing = []
  for (const key of required) {
    const val = snapshot?.[key]
    if (isCampoAusente(val)) {
      missing.push(FIELD_LABELS[key] || key)
      continue
    }
    // E-mail sem formato válido (ex.: "@" corrompido na nota) conta como ausente.
    if (key === 'email' && !isValidEmailShape(val)) {
      missing.push(FIELD_LABELS[key] || key)
    }
  }
  return {
    valid: missing.length === 0,
    missingFields: missing,
    required,
  }
}

export { isCampoAusente }
