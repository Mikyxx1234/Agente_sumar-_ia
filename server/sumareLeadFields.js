/**
 * Escreve campos da aba "Sumaré" do lead no Kommo (sum_Curso, sum_Polo, etc.).
 *
 * Descoberta dinâmica do field_id por nome (cache 5 min). Pode ser
 * sobrescrita por env (KOMMO_FIELD_SUM_CURSO_ID).
 *
 * Atualiza apenas se o valor novo for diferente do atual, evitando
 * PATCHs redundantes a cada turno da conversa.
 */

import { listLeadCustomFields } from './kommoClient.js'
import { kommoRawFetch } from './kommoRateLimiter.js'
import { isEduitBackend, resolveCrmLeadId } from './crmAdapter.js'
import { isEduitCuid, updateDealCustomFields } from './eduitClient.js'

const SUM_CURSO_ALIASES = [
  'sum_curso',
  'sum_Curso',
  'sumcurso',
  'sum curso',
  'curso (sumaré)',
  'curso sumare',
  'curso sumaré',
]

const SUM_POLO_ALIASES = [
  'sum_polo',
  'sum_Polo',
  'sumpolo',
  'sum polo',
  'polo inscrição',
  'polo da inscrição',
  'polo_inscricao',
  'polo da inscricao',
]

const SUM_MOTIVO_PERDA_ALIASES = [
  'sum_motivo da perda',
  'sum_motivo da perdida',
  'sum_motivo perda',
  'sum motivo da perda',
  'motivo da perda',
]

const MOTIVO_PERDA_SEM_INTERESSE = 'Sem Interesse'
const MOTIVO_PERDA_SEM_RESPOSTA = 'Sem resposta'

const FIELD_CACHE_TTL_MS = 5 * 60 * 1000
const LEAD_UPDATE_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000

/** @type {Map<string, { fieldId: number, ts: number }>} */
const fieldCache = new Map()
/** @type {Map<string, { curso: string, ts: number }>} */
const recentUpdates = new Map()
/** @type {Map<string, { polo: string, ts: number }>} */
const recentPoloUpdates = new Map()

function getFieldFromCache(kind) {
  const entry = fieldCache.get(kind)
  if (!entry) return null
  if (Date.now() - entry.ts > FIELD_CACHE_TTL_MS) return null
  return entry.fieldId
}

function setFieldCache(kind, fieldId) {
  fieldCache.set(kind, { fieldId, ts: Date.now() })
}

async function resolveFieldIdByAliases(env, aliases, envOverride) {
  const fromEnv = Number(env[envOverride])
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv

  try {
    const lookup = await listLeadCustomFields(env)
    if (!lookup.ok || !lookup.byName) return null
    for (const alias of aliases) {
      const def = lookup.byName.get(String(alias).trim().toLowerCase())
      if (def?.id) return Number(def.id)
    }
  } catch (err) {
    console.warn('[sumareLeadFields] listLeadCustomFields falhou:', err.message)
  }
  return null
}

async function resolveSumCursoFieldId(env) {
  const cached = getFieldFromCache('sum_curso')
  if (cached) return cached
  const id = await resolveFieldIdByAliases(env, SUM_CURSO_ALIASES, 'KOMMO_FIELD_SUM_CURSO_ID')
  if (id) setFieldCache('sum_curso', id)
  return id
}

async function resolveSumPoloFieldId(env) {
  const cached = getFieldFromCache('sum_polo')
  if (cached) return cached
  const id = await resolveFieldIdByAliases(env, SUM_POLO_ALIASES, 'KOMMO_FIELD_SUM_POLO_ID')
  if (id) setFieldCache('sum_polo', id)
  return id
}

async function resolveSumMotivoPerdaFieldDef(env) {
  const fromEnv = Number(env.KOMMO_FIELD_SUM_MOTIVO_PERDA_ID)
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    const lookup = await listLeadCustomFields(env)
    if (lookup.ok && lookup.byName) {
      for (const def of lookup.byName.values()) {
        if (Number(def.id) === fromEnv) return def
      }
    }
    return { id: fromEnv, enums: null }
  }
  const cached = fieldCache.get('sum_motivo_perda_def')
  if (cached?.def && Date.now() - cached.ts < FIELD_CACHE_TTL_MS) return cached.def

  const lookup = await listLeadCustomFields(env)
  if (!lookup.ok || !lookup.byName) return null
  for (const alias of SUM_MOTIVO_PERDA_ALIASES) {
    const def = lookup.byName.get(String(alias).trim().toLowerCase())
    if (def?.id) {
      fieldCache.set('sum_motivo_perda_def', { def, ts: Date.now() })
      return def
    }
  }
  return null
}

/**
 * Grava `sum_Motivo da perda` (enum) no lead Kommo.
 */
export async function setSumMotivoPerdaByLabel(env, { leadId, telefone, motivoLabel }) {
  const label = String(motivoLabel || '').trim()
  if (!label) return { ok: false, code: 'MOTIVO_LABEL_EMPTY' }

  const idLead = await resolveLeadIdInternal(env, { leadId, telefone })
  if (!idLead) return { ok: false, code: 'LEAD_NOT_FOUND' }

  const fieldDef = await resolveSumMotivoPerdaFieldDef(env)
  if (!fieldDef?.id) return { ok: false, code: 'FIELD_SUM_MOTIVO_PERDA_NOT_FOUND' }

  const enumId = findEnumIdByLabel(fieldDef, label)
  if (!enumId) {
    return {
      ok: false,
      code: 'ENUM_MOTIVO_NOT_FOUND',
      fieldId: fieldDef.id,
      error: `Opção "${label}" não encontrada no campo`,
    }
  }

  const result = await patchLeadCustomFieldEnum(env, idLead, fieldDef.id, enumId)
  return {
    ...result,
    leadId: idLead,
    fieldId: fieldDef.id,
    enumId,
    motivo: label,
  }
}

/** Grava `sum_Motivo da perda` = "Sem Interesse" (enum) no lead Kommo. */
export async function setSumMotivoPerdaSemInteresse(env, { leadId, telefone }) {
  return setSumMotivoPerdaByLabel(env, {
    leadId,
    telefone,
    motivoLabel: MOTIVO_PERDA_SEM_INTERESSE,
  })
}

/** Grava `sum_Motivo da perda` = "Sem resposta" (enum) no lead Kommo. */
export async function setSumMotivoPerdaSemResposta(env, { leadId, telefone }) {
  return setSumMotivoPerdaByLabel(env, {
    leadId,
    telefone,
    motivoLabel: MOTIVO_PERDA_SEM_RESPOSTA,
  })
}

function normalizeFieldLabel(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

function findEnumIdByLabel(fieldDef, label) {
  const want = normalizeFieldLabel(label)
  const enums = Array.isArray(fieldDef?.enums) ? fieldDef.enums : []
  for (const en of enums) {
    const v = normalizeFieldLabel(en?.value ?? en?.name ?? '')
    if (v === want) return Number(en.id)
  }
  return null
}

async function patchLeadCustomFieldEnum(env, leadId, fieldId, enumId) {
  const base = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = env.KOMMO_ACCESS_TOKEN || ''
  if (!base || !token) return { ok: false, code: 'KOMMO_NOT_CONFIGURED' }
  try {
    const res = await kommoRawFetch(`${base}/api/v4/leads/${leadId}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        custom_fields_values: [{ field_id: fieldId, values: [{ enum_id: enumId }] }],
      }),
    })
    const text = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, body: text.slice(0, 300) }
  } catch (err) {
    return { ok: false, code: 'FETCH_FAILED', error: err.message }
  }
}

async function patchLeadCustomField(env, leadId, fieldId, value) {
  const base = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = env.KOMMO_ACCESS_TOKEN || ''
  if (!base || !token) return { ok: false, code: 'KOMMO_NOT_CONFIGURED' }
  try {
    const res = await kommoRawFetch(`${base}/api/v4/leads/${leadId}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        custom_fields_values: [{ field_id: fieldId, values: [{ value }] }],
      }),
    })
    const text = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, body: text.slice(0, 300) }
  } catch (err) {
    return { ok: false, code: 'FETCH_FAILED', error: err.message }
  }
}

async function getCurrentLeadCustomTextField(env, leadId, fieldId) {
  const base = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = env.KOMMO_ACCESS_TOKEN || ''
  if (!base || !token) return ''
  try {
    const res = await kommoRawFetch(`${base}/api/v4/leads/${leadId}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return ''
    const data = await res.json()
    const f = (data.custom_fields_values || []).find((x) => Number(x.field_id) === Number(fieldId))
    return f?.values?.[0]?.value ? String(f.values[0].value).trim() : ''
  } catch {
    return ''
  }
}

async function getCurrentSumCurso(env, leadId, fieldId) {
  return getCurrentLeadCustomTextField(env, leadId, fieldId)
}

async function resolveLeadIdInternal(env, { leadId, telefone }) {
  return resolveCrmLeadId(env, telefone, leadId)
}

async function writeEduitDealField(env, dealId, name, value, fieldId) {
  return updateDealCustomFields(env, dealId, [
    { fieldId, name, value },
  ])
}

/**
 * Grava o curso no campo sum_Curso do lead.
 *
 * @param {Record<string,string>} env
 * @param {{ leadId?: number, telefone?: string, cursoNome: string }} input
 */
export async function setSumCursoOnLead(env, { leadId, telefone, cursoNome }) {
  const curso = String(cursoNome || '').trim()
  if (!curso || curso.length < 3) return { ok: false, code: 'CURSO_INVALIDO' }

  const idLead = await resolveLeadIdInternal(env, { leadId, telefone })
  if (!idLead) return { ok: false, code: 'LEAD_NOT_FOUND' }
  if (isEduitBackend(env) || isEduitCuid(idLead)) {
    const result = await writeEduitDealField(
      env,
      idLead,
      'curso',
      curso,
      'cmt4cxxs6gbxsow01pf26inmn',
    )
    return { ...result, leadId: idLead, curso, via: 'eduit' }
  }

  const dedupeKey = `${idLead}`
  const recent = recentUpdates.get(dedupeKey)
  if (recent && recent.curso.toLowerCase() === curso.toLowerCase() && Date.now() - recent.ts < LEAD_UPDATE_DEDUPE_TTL_MS) {
    return { ok: true, skipped: true, reason: 'recente', curso, leadId: idLead }
  }

  const fieldId = await resolveSumCursoFieldId(env)
  if (!fieldId) return { ok: false, code: 'FIELD_SUM_CURSO_NOT_FOUND' }

  const current = await getCurrentSumCurso(env, idLead, fieldId)
  if (current && current.toLowerCase() === curso.toLowerCase()) {
    recentUpdates.set(dedupeKey, { curso, ts: Date.now() })
    return { ok: true, skipped: true, reason: 'sem_mudanca', curso, leadId: idLead }
  }

  const result = await patchLeadCustomField(env, idLead, fieldId, curso)
  if (result.ok) {
    recentUpdates.set(dedupeKey, { curso, ts: Date.now() })
  }
  return { ...result, fieldId, leadId: idLead, curso, previous: current || null }
}

/**
 * Grava o polo no campo sum_Polo do lead.
 *
 * @param {Record<string,string>} env
 * @param {{ leadId?: number, telefone?: string, poloNome: string }} input
 */
export async function setSumPoloOnLead(env, { leadId, telefone, poloNome }) {
  const polo = String(poloNome || '').trim()
  if (!polo || polo.length < 2) return { ok: false, code: 'POLO_INVALIDO' }

  const idLead = await resolveLeadIdInternal(env, { leadId, telefone })
  if (!idLead) return { ok: false, code: 'LEAD_NOT_FOUND' }
  if (isEduitBackend(env) || isEduitCuid(idLead)) {
    const result = await writeEduitDealField(
      env,
      idLead,
      'polo',
      polo,
      'cmt4cyv21gbyiow016u7zjhl6',
    )
    return { ...result, leadId: idLead, polo, via: 'eduit' }
  }

  const dedupeKey = `${idLead}`
  const recent = recentPoloUpdates.get(dedupeKey)
  if (recent && recent.polo.toLowerCase() === polo.toLowerCase() && Date.now() - recent.ts < LEAD_UPDATE_DEDUPE_TTL_MS) {
    return { ok: true, skipped: true, reason: 'recente', polo, leadId: idLead }
  }

  const fieldId = await resolveSumPoloFieldId(env)
  if (!fieldId) return { ok: false, code: 'FIELD_SUM_POLO_NOT_FOUND' }

  const current = await getCurrentLeadCustomTextField(env, idLead, fieldId)
  if (current && current.toLowerCase() === polo.toLowerCase()) {
    recentPoloUpdates.set(dedupeKey, { polo, ts: Date.now() })
    return { ok: true, skipped: true, reason: 'sem_mudanca', polo, leadId: idLead }
  }

  const result = await patchLeadCustomField(env, idLead, fieldId, polo)
  if (result.ok) {
    recentPoloUpdates.set(dedupeKey, { polo, ts: Date.now() })
  }
  return { ...result, fieldId, leadId: idLead, polo, previous: current || null }
}

/**
 * Grava sum_Polo no Kommo sem interromper o fluxo de inscrição em caso de falha.
 *
 * @param {Record<string,string>} env
 * @param {{ leadId?: number|null, telefone?: string, poloNome: string }} input
 */
export async function syncSumPoloOnLeadQuiet(env, { leadId, telefone, poloNome }) {
  try {
    const r = await setSumPoloOnLead(env, { leadId, telefone, poloNome })
    if (!r.ok && !r.skipped) {
      console.warn('[sumareLeadFields] setSumPoloOnLead:', r.code || r.status, r.body || r.error || '')
    }
    return r
  } catch (err) {
    console.warn('[sumareLeadFields] setSumPoloOnLead failed:', err.message)
    return { ok: false, error: err.message }
  }
}
