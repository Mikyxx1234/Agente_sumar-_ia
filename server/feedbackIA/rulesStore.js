/**
 * Persistência de Feedback IA · Fase 2 — `agent_rules` e
 * `agent_rule_versions`.
 *
 * Toda I/O via Supabase REST (PostgREST). Funções retornam shape
 * `{ ok, code?, status?, error?, data? }` para o caller decidir.
 *
 * Códigos comuns:
 *   TABLE_MISSING  → rodar scripts/sql/agent_rules.sql
 *   NETWORK        → falha de fetch
 *   PG_ERROR       → erro de Postgres (constraint, etc.)
 */

function getCfg(env) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
  return { url, key }
}

async function sbFetch(env, method, pathQuery, body, extraHeaders) {
  const { url, key } = getCfg(env)
  if (!url || !key) {
    return { ok: false, code: 'NO_SUPABASE', error: 'SUPABASE_URL/KEY ausentes' }
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
    const res = await fetch(`${url}/rest/v1/${pathQuery}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!res.ok) {
      const t = typeof data === 'string' ? data : (data?.message || '')
      if (res.status === 404 || /PGRST205/.test(t)) {
        return { ok: false, code: 'TABLE_MISSING', status: res.status, error: t.slice(0, 200) }
      }
      return { ok: false, code: 'PG_ERROR', status: res.status, error: t?.slice?.(0, 400) || `HTTP ${res.status}` }
    }
    return { ok: true, status: res.status, data }
  } catch (e) {
    return { ok: false, code: 'NETWORK', error: e.message }
  }
}

/** Conta linhas em `agent_rules`. */
export async function countAgentRules(env) {
  const r = await sbFetch(env, 'GET', 'agent_rules?select=id&limit=1000')
  if (!r.ok) return r
  return { ok: true, count: Array.isArray(r.data) ? r.data.length : 0 }
}

/** Lista todas as regras ordenadas por id. */
export async function listActiveRules(env) {
  const r = await sbFetch(
    env,
    'GET',
    'agent_rules?select=id,version,title,body,updated_at,updated_by&order=id.asc&limit=99',
  )
  if (!r.ok) return r
  return { ok: true, data: Array.isArray(r.data) ? r.data : [] }
}

/** Seed inicial (idempotente: caller já garantiu COUNT=0). */
export async function insertSeedRules(env, rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { ok: false, code: 'EMPTY_INPUT' }
  }
  const rows = rules.map((r) => ({
    id: r.id,
    version: r.version || 1,
    title: r.title,
    body: r.body,
    updated_by: 'seed',
  }))
  const r1 = await sbFetch(env, 'POST', 'agent_rules', rows, {
    Prefer: 'return=representation',
  })
  if (!r1.ok) return r1
  // Espelha em agent_rule_versions (source='seed').
  const vrows = rows.map((row) => ({
    rule_id: row.id,
    version: row.version,
    body: row.body,
    source: 'seed',
    applied_by: 'seed',
  }))
  await sbFetch(env, 'POST', 'agent_rule_versions', vrows)
  return { ok: true, data: r1.data }
}

/**
 * Aplica patch: insere nova versão E atualiza a row em agent_rules.
 * Faz na ORDEM "versions primeiro" para garantir histórico imutável
 * mesmo se o UPDATE falhar.
 *
 * @param {Record<string,string>} env
 * @param {number} ruleId
 * @param {{ body: string, applied_by?: string, source?: string, source_evaluation_id?: number|null }} payload
 */
export async function applyRulePatch(env, ruleId, payload) {
  const id = Number(ruleId)
  if (!Number.isFinite(id) || id < 1) return { ok: false, code: 'BAD_RULE_ID' }
  const newBody = String(payload?.body || '').trim()
  if (newBody.length < 20) return { ok: false, code: 'BODY_TOO_SHORT', error: 'Corpo da regra muito curto (<20 chars)' }

  // Lê versão atual para incrementar.
  const cur = await sbFetch(env, 'GET', `agent_rules?id=eq.${id}&select=id,version,body&limit=1`)
  if (!cur.ok) return cur
  if (!Array.isArray(cur.data) || cur.data.length === 0) {
    return { ok: false, code: 'RULE_NOT_FOUND', error: `Regra ${id} não existe — rode o seed primeiro.` }
  }
  const currentVersion = Number(cur.data[0].version || 1)
  const nextVersion = currentVersion + 1

  // 1) Snapshot da versão NOVA em agent_rule_versions (imutável).
  const vrow = {
    rule_id: id,
    version: nextVersion,
    body: newBody,
    source: payload?.source || 'patch_approved',
    applied_by: payload?.applied_by || 'dashboard',
    source_evaluation_id: payload?.source_evaluation_id ?? null,
  }
  const ins = await sbFetch(env, 'POST', 'agent_rule_versions', [vrow])
  if (!ins.ok) return ins

  // 2) UPDATE em agent_rules.
  const upd = await sbFetch(
    env,
    'PATCH',
    `agent_rules?id=eq.${id}`,
    {
      body: newBody,
      version: nextVersion,
      updated_at: new Date().toISOString(),
      updated_by: payload?.applied_by || 'dashboard',
    },
    { Prefer: 'return=representation' },
  )
  if (!upd.ok) return upd
  return { ok: true, data: Array.isArray(upd.data) ? upd.data[0] : upd.data, newVersion: nextVersion }
}

/** Lista versões de uma regra. */
export async function listRuleVersions(env, ruleId) {
  const id = Number(ruleId)
  const r = await sbFetch(
    env,
    'GET',
    `agent_rule_versions?rule_id=eq.${id}&select=id,version,body,source,applied_at,applied_by,source_evaluation_id&order=version.desc&limit=50`,
  )
  if (!r.ok) return r
  return { ok: true, data: Array.isArray(r.data) ? r.data : [] }
}

/** Rollback: aplica o body da versão alvo como uma versão nova (incremental). */
export async function rollbackRule(env, ruleId, targetVersion, appliedBy) {
  const id = Number(ruleId)
  const v = Number(targetVersion)
  if (!Number.isFinite(id) || !Number.isFinite(v)) return { ok: false, code: 'BAD_INPUT' }
  const r = await sbFetch(
    env,
    'GET',
    `agent_rule_versions?rule_id=eq.${id}&version=eq.${v}&select=body&limit=1`,
  )
  if (!r.ok) return r
  if (!Array.isArray(r.data) || r.data.length === 0) {
    return { ok: false, code: 'VERSION_NOT_FOUND' }
  }
  return applyRulePatch(env, id, {
    body: r.data[0].body,
    applied_by: appliedBy || 'dashboard',
    source: 'rollback',
  })
}

/**
 * Agrega violações (per_rule.ok=false) em `ai_rule_evaluations` por
 * rule_id na janela informada. Para a aba "Otimizar Prompt".
 */
export async function aggregateViolationsByRule(env, opts = {}) {
  const { sinceIso = null, limit = 200 } = opts
  const filters = []
  if (sinceIso) filters.push(`created_at=gte.${encodeURIComponent(sinceIso)}`)
  const qs = ['select=id,verdict,score,per_rule,lead_id,created_at', 'order=created_at.desc', `limit=${limit}`, ...filters].join('&')
  const r = await sbFetch(env, 'GET', `ai_rule_evaluations?${qs}`)
  if (!r.ok) return r

  const evals = Array.isArray(r.data) ? r.data : []
  const map = new Map() // rule_id → { ruleId, count, samples: [{ evaluationId, evidence, severity, leadId }] }
  for (const ev of evals) {
    const perRule = Array.isArray(ev.per_rule) ? ev.per_rule : []
    for (const pr of perRule) {
      if (pr.ok !== false) continue
      const rid = Number(pr.rule_id)
      if (!Number.isFinite(rid)) continue
      if (!map.has(rid)) map.set(rid, { ruleId: rid, count: 0, severityHigh: 0, samples: [] })
      const slot = map.get(rid)
      slot.count += 1
      if (pr.severity === 'high') slot.severityHigh += 1
      if (slot.samples.length < 5) {
        slot.samples.push({
          evaluationId: ev.id,
          leadId: ev.lead_id,
          evidence: pr.evidence || '',
          severity: pr.severity || 'low',
          suggestion: pr.suggestion || '',
        })
      }
    }
  }

  const list = [...map.values()].sort((a, b) => b.severityHigh - a.severityHigh || b.count - a.count)
  return { ok: true, data: list, totalEvaluations: evals.length }
}
