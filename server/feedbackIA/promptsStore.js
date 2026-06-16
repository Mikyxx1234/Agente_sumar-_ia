/**
 * Persistência dos prompts editáveis do agente — `agent_prompts` e
 * `agent_prompt_versions`.
 *
 * Mesma I/O via Supabase REST (PostgREST) e mesmo shape de retorno do
 * rulesStore.js: `{ ok, code?, status?, error?, data? }`.
 *
 * Códigos comuns:
 *   TABLE_MISSING  → rodar scripts/sql/agent_prompts.sql
 *   NETWORK        → falha de fetch
 *   PG_ERROR       → erro de Postgres (constraint, etc.)
 *
 * Toda escrita aqui só importa quando AGENT_DB_OVERRIDES_ENABLED=true —
 * o promptsLoader só lê esta tabela atrás da flag. A tabela é additiva:
 * criá-la e populá-la NÃO afeta a produção enquanto a flag estiver off.
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

const enc = (s) => encodeURIComponent(String(s))

/** Conta linhas em `agent_prompts`. */
export async function countAgentPrompts(env) {
  const r = await sbFetch(env, 'GET', 'agent_prompts?select=prompt_id&limit=1000')
  if (!r.ok) return r
  return { ok: true, count: Array.isArray(r.data) ? r.data.length : 0 }
}

/** Lista todos os overrides (usado pelo promptsLoader e pela UI). */
export async function listPromptOverrides(env) {
  const r = await sbFetch(
    env,
    'GET',
    'agent_prompts?select=prompt_id,node_name,node_type,body,version,updated_at,updated_by&order=updated_at.desc&limit=200',
  )
  if (!r.ok) return r
  return { ok: true, data: Array.isArray(r.data) ? r.data : [] }
}

/** Lê um override específico. */
export async function getPromptOverride(env, promptId) {
  const r = await sbFetch(
    env,
    'GET',
    `agent_prompts?prompt_id=eq.${enc(promptId)}&select=prompt_id,node_name,node_type,body,version&limit=1`,
  )
  if (!r.ok) return r
  return { ok: true, data: Array.isArray(r.data) && r.data.length ? r.data[0] : null }
}

/**
 * Seed inicial idempotente. Faz upsert (merge-duplicates) por prompt_id,
 * mas só insere snapshot de versão para prompts ainda inexistentes — pra
 * não sobrescrever edições já feitas pelo painel.
 *
 * @param {Array<{prompt_id,node_name,node_type,body}>} prompts
 */
export async function seedPrompts(env, prompts) {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    return { ok: false, code: 'EMPTY_INPUT' }
  }
  const existing = await listPromptOverrides(env)
  if (!existing.ok) return existing
  const have = new Set((existing.data || []).map((r) => r.prompt_id))
  const toInsert = prompts.filter((p) => !have.has(p.prompt_id))
  if (toInsert.length === 0) {
    return { ok: true, data: [], inserted: 0, skipped: prompts.length }
  }
  const rows = toInsert.map((p) => ({
    prompt_id: p.prompt_id,
    node_name: p.node_name || null,
    node_type: p.node_type || null,
    body: p.body,
    version: 1,
    updated_by: 'seed',
  }))
  const r1 = await sbFetch(env, 'POST', 'agent_prompts', rows, {
    Prefer: 'return=representation,resolution=merge-duplicates',
  })
  if (!r1.ok) return r1
  const vrows = rows.map((row) => ({
    prompt_id: row.prompt_id,
    version: 1,
    body: row.body,
    source: 'seed',
    applied_by: 'seed',
  }))
  await sbFetch(env, 'POST', 'agent_prompt_versions', vrows)
  return { ok: true, data: r1.data, inserted: rows.length, skipped: prompts.length - rows.length }
}

/**
 * Aplica edição de um prompt: snapshot da versão nova (imutável) e
 * upsert em agent_prompts. Cria a row se não existir (a UI sempre manda
 * node_name/node_type junto).
 *
 * @param {{ body:string, node_name?:string, node_type?:string, applied_by?:string, source?:string }} payload
 */
export async function applyPromptPatch(env, promptId, payload) {
  const pid = String(promptId || '').trim()
  if (!pid) return { ok: false, code: 'BAD_PROMPT_ID' }
  const newBody = String(payload?.body || '').trim()
  if (newBody.length < 20) {
    return { ok: false, code: 'BODY_TOO_SHORT', error: 'Corpo do prompt muito curto (<20 chars)' }
  }

  const cur = await getPromptOverride(env, pid)
  if (!cur.ok) return cur
  const currentVersion = cur.data ? Number(cur.data.version || 1) : 0
  const nextVersion = currentVersion + 1

  // 1) Snapshot imutável primeiro.
  const vrow = {
    prompt_id: pid,
    version: nextVersion,
    body: newBody,
    source: payload?.source || 'edit',
    applied_by: payload?.applied_by || 'dashboard',
  }
  const ins = await sbFetch(env, 'POST', 'agent_prompt_versions', [vrow])
  if (!ins.ok) return ins

  // 2) Upsert na tabela principal.
  const row = {
    prompt_id: pid,
    node_name: payload?.node_name ?? cur.data?.node_name ?? null,
    node_type: payload?.node_type ?? cur.data?.node_type ?? null,
    body: newBody,
    version: nextVersion,
    updated_at: new Date().toISOString(),
    updated_by: payload?.applied_by || 'dashboard',
  }
  const up = await sbFetch(env, 'POST', 'agent_prompts', [row], {
    Prefer: 'return=representation,resolution=merge-duplicates',
  })
  if (!up.ok) return up
  return { ok: true, data: Array.isArray(up.data) ? up.data[0] : up.data, newVersion: nextVersion }
}

/** Lista versões de um prompt. */
export async function listPromptVersions(env, promptId) {
  const r = await sbFetch(
    env,
    'GET',
    `agent_prompt_versions?prompt_id=eq.${enc(promptId)}&select=id,version,body,source,applied_at,applied_by&order=version.desc&limit=50`,
  )
  if (!r.ok) return r
  return { ok: true, data: Array.isArray(r.data) ? r.data : [] }
}

/** Rollback: reaplica o body de uma versão alvo como versão nova. */
export async function rollbackPrompt(env, promptId, targetVersion, appliedBy) {
  const pid = String(promptId || '').trim()
  const v = Number(targetVersion)
  if (!pid || !Number.isFinite(v)) return { ok: false, code: 'BAD_INPUT' }
  const r = await sbFetch(
    env,
    'GET',
    `agent_prompt_versions?prompt_id=eq.${enc(pid)}&version=eq.${v}&select=body&limit=1`,
  )
  if (!r.ok) return r
  if (!Array.isArray(r.data) || r.data.length === 0) {
    return { ok: false, code: 'VERSION_NOT_FOUND' }
  }
  return applyPromptPatch(env, pid, {
    body: r.data[0].body,
    applied_by: appliedBy || 'dashboard',
    source: 'rollback',
  })
}
