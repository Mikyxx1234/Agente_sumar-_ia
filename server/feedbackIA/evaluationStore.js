/**
 * Persistência da avaliação automática de Feedback IA.
 *
 * Lê e grava em `ai_rule_evaluations` no Supabase principal
 * (SUPABASE_URL). Idempotência via `conversation_key` UNIQUE — quando
 * o lead sai/volta do funil sem novas mensagens da IA, o INSERT é
 * ignorado e a UI continua mostrando a última avaliação.
 *
 * Também lê `mensagens_ia` para montar a transcrição da conversa que
 * será avaliada.
 */

const REST_PATH = '/rest/v1'

function getConfig(env) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
  return { url, key }
}

async function sbFetch(env, method, pathAndQuery, body, extraHeaders) {
  const { url, key } = getConfig(env)
  if (!url || !key) {
    return { ok: false, status: 0, error: 'SUPABASE_URL/SUPABASE_KEY ausentes' }
  }
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...(extraHeaders || {}),
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json'
  }
  try {
    const res = await fetch(`${url}${REST_PATH}/${pathAndQuery}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { ok: res.ok, status: res.status, data, raw: text }
  } catch (e) {
    return { ok: false, status: 0, error: e.message }
  }
}

/**
 * Lê todas as mensagens da IA com o lead na janela informada (ou sem
 * limite de início, se since for null). Retorna ordenado por
 * created_at ASC.
 *
 * @param {Record<string,string>} env
 * @param {{ leadId?: number|string, telefone?: string, sinceIso?: string|null, untilIso?: string|null, limit?: number }} opts
 */
export async function listExecutionsForLead(env, opts) {
  const { leadId, telefone, sinceIso, untilIso, limit = 200 } = opts || {}
  const filters = []
  if (leadId != null && leadId !== '') {
    // `mensagens_ia.usage` é jsonb. O executionTelemetry grava
    // `usage.lead_id` (numérico) e `usage.telefone` (string) no topo.
    filters.push(`usage->>lead_id=eq.${encodeURIComponent(String(leadId))}`)
  }
  if (telefone) {
    filters.push(`usage->>telefone=eq.${encodeURIComponent(telefone)}`)
  }
  if (sinceIso) filters.push(`created_at=gte.${encodeURIComponent(sinceIso)}`)
  if (untilIso) filters.push(`created_at=lte.${encodeURIComponent(untilIso)}`)

  const qs = ['select=*', 'order=created_at.asc', `limit=${limit}`, ...filters].join('&')
  const r = await sbFetch(env, 'GET', `mensagens_ia?${qs}`)
  if (!r.ok) {
    console.warn(`[feedbackIA.store] listExecutionsForLead falhou status=${r.status} err=${r.error || r.raw?.slice(0, 200)}`)
    return []
  }
  return Array.isArray(r.data) ? r.data : []
}

/**
 * Insere uma avaliação. Em conflito de `conversation_key`, NÃO atualiza
 * — devolve { ok:false, code:'DUPLICATE' } para o caller decidir.
 */
export async function insertEvaluation(env, row) {
  const r = await sbFetch(
    env,
    'POST',
    'ai_rule_evaluations',
    [row],
    { Prefer: 'return=representation' },
  )
  if (r.ok && Array.isArray(r.data) && r.data[0]) {
    return { ok: true, data: r.data[0] }
  }
  // Conflict unique violation
  const errText = typeof r.data === 'string' ? r.data : (r.data?.message || '')
  if (r.status === 409 || /duplicate key|unique constraint/i.test(errText)) {
    return { ok: false, code: 'DUPLICATE' }
  }
  if (r.status === 404 || /PGRST205/.test(errText)) {
    return { ok: false, code: 'TABLE_MISSING', error: 'Rode scripts/sql/ai_rule_evaluations.sql no Supabase.' }
  }
  return { ok: false, code: 'INSERT_FAILED', status: r.status, error: errText || r.error }
}

/** Listagem para a UI. */
export async function listEvaluations(env, opts) {
  const { sinceIso, untilIso, verdict, leadId, limit = 200 } = opts || {}
  const filters = []
  if (sinceIso) filters.push(`created_at=gte.${encodeURIComponent(sinceIso)}`)
  if (untilIso) filters.push(`created_at=lte.${encodeURIComponent(untilIso)}`)
  if (verdict) filters.push(`verdict=eq.${encodeURIComponent(verdict)}`)
  if (leadId) filters.push(`lead_id=eq.${encodeURIComponent(String(leadId))}`)
  const qs = ['select=*', 'order=created_at.desc', `limit=${limit}`, ...filters].join('&')
  const r = await sbFetch(env, 'GET', `ai_rule_evaluations?${qs}`)
  if (!r.ok) {
    const text = typeof r.data === 'string' ? r.data : (r.data?.message || r.raw || '')
    if (r.status === 404 || /PGRST205/.test(text)) {
      return {
        ok: false,
        code: 'TABLE_MISSING',
        status: 200,
        error: 'Tabela ai_rule_evaluations ausente. Rode scripts/sql/ai_rule_evaluations.sql no Supabase.',
        data: [],
      }
    }
    return { ok: false, status: r.status, error: r.error || text?.slice(0, 200), data: [] }
  }
  return { ok: true, data: Array.isArray(r.data) ? r.data : [] }
}

/**
 * KPIs simples (hoje / esta semana / pendentes). Usa count via
 * `Prefer: count=exact` do PostgREST.
 */
export async function getEvaluationStats(env) {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const dow = now.getDay() // 0=dom
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((dow + 6) % 7))
  const startOfWeek = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate()).toISOString()

  async function count(filterQuery) {
    const r = await sbFetch(
      env,
      'GET',
      `ai_rule_evaluations?select=id&${filterQuery}`,
      undefined,
      { Prefer: 'count=exact', Range: '0-0' },
    )
    // PostgREST devolve o total no header Content-Range "0-0/<total>",
    // mas como sbFetch não expõe headers, fazemos um workaround simples:
    // contar pelo length quando limit é alto. Para precisão, pedimos
    // até 5000 ids — suficiente para o dashboard local.
    const r2 = await sbFetch(env, 'GET', `ai_rule_evaluations?select=id&${filterQuery}&limit=5000`)
    return r2.ok && Array.isArray(r2.data) ? r2.data.length : 0
  }

  const [todayCount, weekCount, queueCount] = await Promise.all([
    count(`created_at=gte.${encodeURIComponent(startOfDay)}`),
    count(`created_at=gte.${encodeURIComponent(startOfWeek)}`),
    count(`status=eq.pending`),
  ])
  return { todayCount, weekCount, queueCount }
}
