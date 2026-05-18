/**
 * Persistência de feedback de execuções (treinamento de comportamento).
 * Tabela: agent_training_feedback (ver scripts/sql/agent_training_feedback.sql).
 */

const DEFAULT_TABLE = 'agent_training_feedback'

function getConfig(env) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
  const table = env.TRAINING_FEEDBACK_TABLE || DEFAULT_TABLE
  if (!url || !key) return null
  return { url, key, table }
}

function mapRow(row) {
  if (!row) return null
  return {
    executionId: row.execution_id,
    rating: row.rating,
    suggestion: row.suggestion || '',
    userMessage: row.user_message || '',
    response: row.agent_response || '',
    model: row.model || null,
    telefone: row.telefone || null,
    leadId: row.lead_id || null,
    origem: row.origem || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function sbFetch(cfg, method, pathAndQuery, body, prefer) {
  const headers = {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers.Prefer = prefer || 'return=representation'
  }
  const res = await fetch(`${cfg.url}/rest/v1/${pathAndQuery}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { ok: res.ok, status: res.status, data, raw: text }
}

export async function listTrainingFeedback(env, { limit = 500, rating } = {}) {
  const cfg = getConfig(env)
  if (!cfg) return { ok: false, code: 'SUPABASE_NOT_CONFIGURED' }

  const params = new URLSearchParams({
    select: '*',
    order: 'updated_at.desc',
    limit: String(Math.min(1000, Math.max(1, limit))),
  })
  if (rating === 'positive' || rating === 'negative') {
    params.set('rating', `eq.${rating}`)
  }

  const r = await sbFetch(cfg, 'GET', `${cfg.table}?${params}`)
  if (r.status === 404 || r.status === 406) {
    return {
      ok: false,
      code: 'TABLE_MISSING',
      error: `Tabela ${cfg.table} não existe. Rode scripts/sql/agent_training_feedback.sql no Supabase.`,
    }
  }
  if (!r.ok) {
    return { ok: false, code: 'SUPABASE_READ_FAILED', status: r.status, error: String(r.raw).slice(0, 400) }
  }
  const rows = Array.isArray(r.data) ? r.data : []
  return { ok: true, rows: rows.map(mapRow) }
}

export async function getTrainingFeedback(env, executionId) {
  const cfg = getConfig(env)
  if (!cfg) return { ok: false, code: 'SUPABASE_NOT_CONFIGURED' }
  if (!executionId) return { ok: false, code: 'MISSING_EXECUTION_ID' }

  const enc = encodeURIComponent(executionId)
  const r = await sbFetch(cfg, 'GET', `${cfg.table}?execution_id=eq.${enc}&select=*&limit=1`)
  if (!r.ok) {
    return { ok: false, code: 'SUPABASE_READ_FAILED', status: r.status, error: String(r.raw).slice(0, 400) }
  }
  const rows = Array.isArray(r.data) ? r.data : []
  return { ok: true, row: rows.length ? mapRow(rows[0]) : null }
}

export async function upsertTrainingFeedback(env, payload) {
  const cfg = getConfig(env)
  if (!cfg) return { ok: false, code: 'SUPABASE_NOT_CONFIGURED' }

  const executionId = String(payload.executionId || payload.execution_id || '').trim()
  const rating = payload.rating
  if (!executionId) return { ok: false, code: 'MISSING_EXECUTION_ID' }
  if (rating !== 'positive' && rating !== 'negative') {
    return { ok: false, code: 'INVALID_RATING', error: 'rating deve ser positive ou negative' }
  }

  const now = new Date().toISOString()
  const row = {
    execution_id: executionId,
    rating,
    suggestion: rating === 'negative' ? String(payload.suggestion || '').trim() || null : null,
    user_message: payload.userMessage ?? payload.user_message ?? null,
    agent_response: payload.response ?? payload.agent_response ?? null,
    model: payload.model ?? null,
    telefone: payload.telefone ?? null,
    lead_id: payload.leadId != null ? String(payload.leadId) : payload.lead_id ?? null,
    origem: payload.origem ?? null,
    created_by: payload.createdBy ?? payload.created_by ?? 'dashboard',
    updated_at: now,
  }

  const r = await sbFetch(
    cfg,
    'POST',
    `${cfg.table}?on_conflict=execution_id`,
    [row],
    'resolution=merge-duplicates,return=representation',
  )

  if (r.status === 404 || r.status === 406) {
    return {
      ok: false,
      code: 'TABLE_MISSING',
      error: `Tabela ${cfg.table} não existe. Rode scripts/sql/agent_training_feedback.sql no Supabase.`,
    }
  }
  if (!r.ok) {
    return { ok: false, code: 'SUPABASE_WRITE_FAILED', status: r.status, error: String(r.raw).slice(0, 400) }
  }
  const saved = Array.isArray(r.data) && r.data[0] ? mapRow(r.data[0]) : mapRow({ ...row, created_at: now })
  return { ok: true, row: saved }
}

export async function deleteTrainingFeedback(env, executionId) {
  const cfg = getConfig(env)
  if (!cfg) return { ok: false, code: 'SUPABASE_NOT_CONFIGURED' }
  if (!executionId) return { ok: false, code: 'MISSING_EXECUTION_ID' }

  const enc = encodeURIComponent(executionId)
  const r = await sbFetch(cfg, 'DELETE', `${cfg.table}?execution_id=eq.${enc}`)
  if (!r.ok && r.status !== 404) {
    return { ok: false, code: 'SUPABASE_DELETE_FAILED', status: r.status, error: String(r.raw).slice(0, 400) }
  }
  return { ok: true }
}

/** Mapa execution_id → feedback (formato do front). */
export async function listTrainingFeedbackMap(env, opts = {}) {
  const out = await listTrainingFeedback(env, opts)
  if (!out.ok) return out
  const map = {}
  for (const row of out.rows) {
    map[row.executionId] = {
      rating: row.rating,
      suggestion: row.suggestion,
      userMessage: row.userMessage,
      response: row.response,
      updatedAt: row.updatedAt,
    }
  }
  return { ok: true, map, rows: out.rows }
}
