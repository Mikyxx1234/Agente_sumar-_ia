/**
 * Feedback de qualidade das execuções — Supabase (agent_training_feedback).
 * Grava via proxy /api/supabase (mesmo padrão de mensagens_ia), sem depender
 * da rota /api/training/feedback no Express (evita 404 com servidor antigo).
 */

const SUPABASE_BASE = '/api/supabase'
const TABLE = 'agent_training_feedback'
const STORAGE_KEY = 'execution_response_feedback_v1'
const MIGRATED_KEY = 'execution_feedback_migrated_v2'

function loadLocalAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveLocalAll(map) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

function mapRow(r) {
  if (!r) return null
  return {
    rating: r.rating,
    suggestion: r.suggestion || '',
    userMessage: r.user_message || '',
    response: r.agent_response || '',
    updatedAt: r.updated_at,
  }
}

function buildDbRow(executionId, payload) {
  const now = new Date().toISOString()
  return {
    execution_id: executionId,
    rating: payload.rating,
    suggestion: payload.rating === 'negative' ? (payload.suggestion?.trim() || null) : null,
    user_message: payload.userMessage ?? null,
    agent_response: payload.response ?? null,
    model: payload.model ?? null,
    telefone: payload.telefone ?? null,
    lead_id: payload.leadId != null ? String(payload.leadId) : null,
    origem: payload.origem ?? null,
    created_by: 'dashboard',
    updated_at: now,
  }
}

async function supabaseFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  }
  const res = await fetch(`${SUPABASE_BASE}/rest/v1/${path}`, { ...options, headers })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { ok: res.ok, status: res.status, data, raw: text }
}

async function upsertToSupabase(executionId, payload) {
  const row = buildDbRow(executionId, payload)
  const r = await supabaseFetch(`${TABLE}?on_conflict=execution_id`, {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([row]),
  })
  if (r.status === 404 || (r.data?.code === 'PGRST205')) {
    return {
      ok: false,
      code: 'TABLE_MISSING',
      error: 'Tabela agent_training_feedback não encontrada. Rode scripts/sql/agent_training_feedback.sql no Supabase.',
    }
  }
  if (!r.ok) {
    return { ok: false, code: 'SUPABASE_WRITE_FAILED', status: r.status, error: String(r.raw).slice(0, 300) }
  }
  const saved = Array.isArray(r.data) && r.data[0] ? mapRow(r.data[0]) : mapRow({ ...row, updated_at: row.updated_at })
  return { ok: true, data: saved, source: 'supabase' }
}

async function deleteFromSupabase(executionId) {
  const enc = encodeURIComponent(executionId)
  await supabaseFetch(`${TABLE}?execution_id=eq.${enc}`, { method: 'DELETE' })
}

/** Carrega feedback do Supabase; em falha usa localStorage. */
export async function getAllExecutionFeedback() {
  const r = await supabaseFetch(
    `${TABLE}?select=execution_id,rating,suggestion,user_message,agent_response,updated_at&order=updated_at.desc&limit=500`,
    { method: 'GET', headers: {} },
  )
  if (r.ok && Array.isArray(r.data)) {
    const map = {}
    for (const row of r.data) {
      map[row.execution_id] = mapRow(row)
    }
    saveLocalAll(map)
    return map
  }
  if (r.status === 404) {
    console.warn('[executionFeedback] tabela ausente no Supabase')
  }
  return loadLocalAll()
}

export async function getExecutionFeedback(executionId) {
  if (!executionId) return null
  const enc = encodeURIComponent(executionId)
  const r = await supabaseFetch(
    `${TABLE}?execution_id=eq.${enc}&select=execution_id,rating,suggestion,user_message,agent_response,updated_at&limit=1`,
    { method: 'GET', headers: {} },
  )
  if (r.ok && Array.isArray(r.data) && r.data[0]) return mapRow(r.data[0])
  const local = loadLocalAll()[executionId]
  return local?.rating ? local : null
}

export async function saveExecutionFeedback(executionId, payload) {
  if (!executionId) return { ok: false, error: 'executionId obrigatório' }

  const out = await upsertToSupabase(executionId, payload)
  if (out.ok) {
    const map = loadLocalAll()
    map[executionId] = out.data
    saveLocalAll(map)
    return out
  }

  if (out.code === 'TABLE_MISSING') {
    return out
  }

  console.warn('[executionFeedback] Supabase falhou, cache local:', out.error)
  const map = loadLocalAll()
  const prev = map[executionId] || {}
  map[executionId] = {
    ...prev,
    rating: payload.rating,
    suggestion: payload.suggestion?.trim() || '',
    userMessage: payload.userMessage ?? prev.userMessage ?? '',
    response: payload.response ?? prev.response ?? '',
    updatedAt: new Date().toISOString(),
  }
  saveLocalAll(map)
  return { ok: true, data: map[executionId], source: 'local', warning: out.error }
}

export async function clearExecutionFeedback(executionId) {
  await deleteFromSupabase(executionId)
  const map = loadLocalAll()
  delete map[executionId]
  saveLocalAll(map)
}

/** Envia avaliações do localStorage para o Supabase (uma vez por versão). */
export async function migrateLocalFeedbackToServer() {
  if (localStorage.getItem(MIGRATED_KEY) === '1') return { ok: true, skipped: true }
  const local = loadLocalAll()
  const ids = Object.keys(local)
  if (ids.length === 0) {
    localStorage.setItem(MIGRATED_KEY, '1')
    return { ok: true, migrated: 0 }
  }
  let migrated = 0
  for (const executionId of ids) {
    const row = local[executionId]
    if (!row?.rating) continue
    const r = await saveExecutionFeedback(executionId, {
      rating: row.rating,
      suggestion: row.suggestion,
      userMessage: row.userMessage,
      response: row.response,
    })
    if (r.ok && r.source === 'supabase') migrated++
  }
  localStorage.setItem(MIGRATED_KEY, '1')
  return { ok: true, migrated }
}
