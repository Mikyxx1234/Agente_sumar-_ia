/**
 * Leitura e validação dos campos do lead no Kommo após o Form Sumar.
 */

import { listLeadCustomFields } from './kommoClient.js'

const KOMMO_FIELD_NOME = 304628

const FIELD_ALIASES = {
  email: ['e-mail', 'email', 'e_mail'],
  cpf: ['cpf', 'documento', 'cnpj/cpf'],
  cursoInscricao: ['curso inscrição', 'curso da inscrição', 'curso_inscricao', 'curso da inscricao'],
  tipoInscricao: ['tipo inscrição', 'tipo de ingresso', 'tipo_inscricao', 'tipo de inscrição'],
  poloInscricao: ['polo inscrição', 'polo da inscrição', 'polo_inscricao'],
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
  const nomeField = pickCustomFieldValue(custom, KOMMO_FIELD_NOME) || pickCustomFieldValue(contact?.custom_fields_values, KOMMO_FIELD_NOME)
  const email =
    pickByAliases(custom, fieldsByName, FIELD_ALIASES.email) ||
    pickByAliases(contact?.custom_fields_values, fieldsByName, FIELD_ALIASES.email)
  const cpf =
    pickByAliases(custom, fieldsByName, FIELD_ALIASES.cpf) ||
    pickByAliases(contact?.custom_fields_values, fieldsByName, FIELD_ALIASES.cpf)
  const cursoInscricao = pickByAliases(custom, fieldsByName, FIELD_ALIASES.cursoInscricao)
  const tipoInscricao = pickByAliases(custom, fieldsByName, FIELD_ALIASES.tipoInscricao)
  const poloInscricao = pickByAliases(custom, fieldsByName, FIELD_ALIASES.poloInscricao)

  return {
    ok: true,
    lead,
    snapshot: {
      nome: !isCampoAusente(nomeField) ? nomeField : nomeLead,
      email,
      cpf,
      curso_inscricao: cursoInscricao,
      tipo_inscricao: tipoInscricao,
      polo_inscricao: poloInscricao,
      responsible_user_id: Number(lead.responsible_user_id) || 0,
      status_id: Number(lead.status_id) || 0,
      pipeline_id: Number(lead.pipeline_id) || 0,
    },
  }
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
export function validateFormSnapshot(env, snapshot) {
  const required = getRequiredFormFieldKeys(env)
  const missing = []
  for (const key of required) {
    const val = snapshot?.[key]
    if (isCampoAusente(val)) {
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
