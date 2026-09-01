/**
 * Leitura e validação dos campos do lead no Kommo após o Form Sumar.
 */

import { listLeadCustomFields, listLeadNotes } from './kommoClient.js'
import { kommoRawFetch } from './kommoRateLimiter.js'
import { parseFormDataNoteFields } from '../libShared/inscricaoFormHeuristics.js'
import { normalizeCpf, kommoDataNascLooksInvalid } from './sumareCaptacaoClient.js'
import { isGarbageCursoInscricao } from '../libShared/captacaoSnapshotSanitize.js'
import { contactPhoneDigits, getDealById, isEduitCuid } from './eduitClient.js'
import { isEduitBackend } from './crmAdapter.js'

const KOMMO_FIELD_NOME = 304628

/** Fallback CUID de campos EduIT (docs) — preferir match por name normalizado. */
const EDUIT_FIELD_ID_FALLBACK = {
  curso: 'cmt4cxxs6gbxsow01pf26inmn',
  polo: 'cmt4cyv21gbyiow016u7zjhl6',
}

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
  origem: ['sum_origem', 'sum origem', 'origem', 'origem lead', 'origem do lead'],
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

function normalizeEduitFieldKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_-]+/g, '')
}

/**
 * Lê valor de dealPanelFields EduIT. Prefere names normalizados; fieldIds só como fallback.
 * Não inventa valor — vazio/null permanece ''.
 */
function pickEduitPanelValue(panelFields, { names = [], fieldIds = [] } = {}) {
  if (!Array.isArray(panelFields) || panelFields.length === 0) return ''
  const byName = new Map()
  for (const f of panelFields) {
    const key = normalizeEduitFieldKey(f?.name)
    if (key && !byName.has(key)) byName.set(key, f)
  }
  for (const name of names) {
    const f = byName.get(normalizeEduitFieldKey(name))
    if (!f) continue
    const v = f.value
    if (v != null && String(v).trim()) return String(v).trim()
  }
  for (const id of fieldIds) {
    if (!id) continue
    const want = String(id).trim()
    const f = panelFields.find(
      (x) => String(x?.fieldId || x?.field_id || '').trim() === want,
    )
    if (!f) continue
    const v = f.value
    if (v != null && String(v).trim()) return String(v).trim()
  }
  return ''
}

function snapshotFromEduitDeal(deal) {
  const panel = Array.isArray(deal?.dealPanelFields) ? deal.dealPanelFields : []
  const nomePanel = pickEduitPanelValue(panel, { names: ['nome', 'sum_nome', 'nomecompleto'] })
  const title = String(deal?.title || deal?.name || '').trim()
  const snapshot = {
    nome: !isCampoAusente(nomePanel) ? nomePanel : title,
    email: pickEduitPanelValue(panel, { names: ['email', 'e-mail', 'e_mail'] }),
    cpf: pickEduitPanelValue(panel, { names: ['cpf'] }),
    curso_inscricao: pickEduitPanelValue(panel, {
      names: ['curso', 'curso_inscricao', 'cursoinscricao'],
      fieldIds: [EDUIT_FIELD_ID_FALLBACK.curso],
    }),
    tipo_inscricao: pickEduitPanelValue(panel, {
      names: ['tipo_inscricao', 'tipoinscricao', 'tipo'],
    }),
    polo_inscricao: pickEduitPanelValue(panel, {
      names: ['polo', 'polo_inscricao', 'poloinscricao'],
      fieldIds: [EDUIT_FIELD_ID_FALLBACK.polo],
    }),
    data_nasc: pickEduitPanelValue(panel, {
      names: ['dtnascimento', 'data_nasc', 'datanascimento', 'nascimento'],
    }),
    sexo: pickEduitPanelValue(panel, { names: ['sexo', 'genero', 'gênero'] }),
    unidade: pickEduitPanelValue(panel, { names: ['unidade', 'campus'] }),
    turno: pickEduitPanelValue(panel, { names: ['turno'] }),
    modalidade: pickEduitPanelValue(panel, { names: ['modalidade'] }),
    status_inscricao: pickEduitPanelValue(panel, {
      names: ['status_inscricao', 'statusinscricao', 'status'],
    }),
    origem: pickEduitPanelValue(panel, { names: ['origem'] }),
    responsible_user_id: Number(deal?.ownerId || deal?.responsible_user_id) || 0,
    status_id: Number(deal?.status_id) || 0,
    pipeline_id: Number(deal?.pipeline_id) || 0,
  }
  if (isGarbageCursoInscricao(snapshot.curso_inscricao)) {
    snapshot.curso_inscricao = ''
  }
  return snapshot
}

async function fetchEduitLeadFormSnapshot(env, dealId) {
  const got = await getDealById(env, dealId)
  if (!got.ok || !got.deal) {
    return {
      ok: false,
      error: got.error || 'deal_nao_encontrado',
      code: got.code || undefined,
    }
  }
  const deal = got.deal
  const snapshot = snapshotFromEduitDeal(deal)
  const contact = deal?.contact || deal?.contacts?.[0] || null
  const phones = contact ? contactPhoneDigits(contact) : []
  const lead = {
    ...deal,
    id: deal.id || dealId,
    name: deal.title || deal.name || snapshot.nome || '',
    ...(phones[0] ? { phone: phones[0] } : {}),
  }
  return { ok: true, lead, snapshot }
}

async function kommoGetLead(env, leadId) {
  const base = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = env.KOMMO_ACCESS_TOKEN || ''
  if (!base || !token) return null
  const res = await kommoRawFetch(`${base}/api/v4/leads/${leadId}?with=contacts`, {
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
 * @returns {Promise<{ ok: boolean, lead?: object, snapshot?: object, fieldsByName?: Map, error?: string }>}
 */
export async function fetchLeadFormSnapshot(env, leadId) {
  const rawId = String(leadId ?? '').trim()
  if (isEduitCuid(rawId)) {
    return fetchEduitLeadFormSnapshot(env, rawId)
  }
  if (isEduitBackend(env)) {
    return { ok: false, error: 'lead_id_invalido' }
  }

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
  const origem = pickByAliases(custom, fieldsByName, FIELD_ALIASES.origem)

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
    origem,
    responsible_user_id: Number(lead.responsible_user_id) || 0,
    status_id: Number(lead.status_id) || 0,
    pipeline_id: Number(lead.pipeline_id) || 0,
  }

  const phoneDigits = extractContactPhoneDigits(contact)
  const enriched = await enrichSnapshotFromFormNote(env, id, snapshot, phoneDigits)
  if (isGarbageCursoInscricao(enriched.curso_inscricao)) {
    enriched.curso_inscricao = ''
  }
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
function snapshotFieldNeedsNoteEnrichment(key, val, phoneDigits) {
  if (isCampoAusente(val)) return true
  // CPF presente mas inválido (10 dígitos no Kommo) → busca na nota do formulário.
  if (key === 'cpf' && !normalizeCpf(val)) return true
  // Data de nascimento com telefone ou lixo → busca na nota do formulário.
  if (key === 'data_nasc' && kommoDataNascLooksInvalid(val, phoneDigits)) return true
  return false
}

function extractContactPhoneDigits(contact) {
  const fields = contact?.custom_fields_values
  if (!Array.isArray(fields)) return ''
  for (const f of fields) {
    const code = String(f?.field_code || f?.code || '').toUpperCase()
    if (code !== 'PHONE' && !/telefone|celular|phone/i.test(String(f?.field_name || ''))) continue
    const v = f?.values?.[0]?.value
    if (v != null && String(v).replace(/\D/g, '').length >= 10) {
      return String(v).replace(/\D/g, '')
    }
  }
  return ''
}

async function enrichSnapshotFromFormNote(env, leadId, snapshot, phoneDigits = '') {
  const keys = ['nome', 'email', 'cpf', 'data_nasc', 'sexo']
  const missing = keys.filter((k) =>
    snapshotFieldNeedsNoteEnrichment(k, snapshot?.[k], phoneDigits),
  )
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
      if (snapshotFieldNeedsNoteEnrichment(k, merged[k], phoneDigits) && fields[k]) {
        merged[k] = fields[k]
      }
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
    if (key === 'cpf' && !normalizeCpf(val)) {
      missing.push(FIELD_LABELS[key] || key)
    }
    if (key === 'curso_inscricao' && isGarbageCursoInscricao(val)) {
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
