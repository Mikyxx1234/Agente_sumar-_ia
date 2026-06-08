/**
 * Escreve campos da aba "Sumaré" do lead no Kommo (sum_Curso, etc.).
 *
 * Descoberta dinâmica do field_id por nome (cache 5 min). Pode ser
 * sobrescrita por env (KOMMO_FIELD_SUM_CURSO_ID).
 *
 * Atualiza apenas se o valor novo for diferente do atual, evitando
 * PATCHs redundantes a cada turno da conversa.
 */

import { listLeadCustomFields, findLeadByPhone } from './kommoClient.js'
import { kommoRawFetch } from './kommoRateLimiter.js'

const SUM_CURSO_ALIASES = [
  'sum_curso',
  'sum_Curso',
  'sumcurso',
  'sum curso',
  'curso (sumaré)',
  'curso sumare',
  'curso sumaré',
]

const SUM_MOTIVO_PERDA_ALIASES = [
  'sum_motivo da perda',
  'sum_motivo da perdida',
  'sum_motivo perda',
  'sum motivo da perda',
  'motivo da perda',
]

const MOTIVO_PERDA_SEM_INTERESSE = 'Sem Interesse'

const FIELD_CACHE_TTL_MS = 5 * 60 * 1000
const LEAD_UPDATE_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000

/** @type {Map<string, { fieldId: number, ts: number }>} */
const fieldCache = new Map()
/** @type {Map<string, { curso: string, ts: number }>} */
const recentUpdates = new Map()

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
 * Grava `sum_Motivo da perda` = "Sem Interesse" (enum) no lead Kommo.
 */
export async function setSumMotivoPerdaSemInteresse(env, { leadId, telefone }) {
  const idLead = await resolveLeadIdInternal(env, { leadId, telefone })
  if (!idLead) return { ok: false, code: 'LEAD_NOT_FOUND' }

  const fieldDef = await resolveSumMotivoPerdaFieldDef(env)
  if (!fieldDef?.id) return { ok: false, code: 'FIELD_SUM_MOTIVO_PERDA_NOT_FOUND' }

  const enumId = findEnumIdByLabel(fieldDef, MOTIVO_PERDA_SEM_INTERESSE)
  if (!enumId) {
    return {
      ok: false,
      code: 'ENUM_SEM_INTERESSE_NOT_FOUND',
      fieldId: fieldDef.id,
      error: `Opção "${MOTIVO_PERDA_SEM_INTERESSE}" não encontrada no campo`,
    }
  }

  const result = await patchLeadCustomFieldEnum(env, idLead, fieldDef.id, enumId)
  return {
    ...result,
    leadId: idLead,
    fieldId: fieldDef.id,
    enumId,
    motivo: MOTIVO_PERDA_SEM_INTERESSE,
  }
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

async function getCurrentSumCurso(env, leadId, fieldId) {
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

async function resolveLeadIdInternal(env, { leadId, telefone }) {
  const id = Number(leadId)
  if (Number.isFinite(id) && id > 0) return id
  if (!telefone) return null
  try {
    const lookup = await findLeadByPhone(env, telefone)
    if (lookup.ok && lookup.lead?.id) return Number(lookup.lead.id)
  } catch {
    /* ignore */
  }
  return null
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
