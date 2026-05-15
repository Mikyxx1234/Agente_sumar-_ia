/**
 * AI Control State — kill switch da IA.
 *
 * Permite desligar/ligar o agente em produção sem precisar reiniciar nem
 * mexer em variável de ambiente. Quando desligado, o `flushSessionInner`
 * (em server/evolution/webhookEvolution.js) faz early return SEM esvaziar
 * o buffer — assim que religar, o próximo tick do scheduler processa o
 * backlog acumulado.
 *
 * Persistência:
 *   - Primário: tabela Supabase `app_settings (key text PK, value jsonb,
 *     updated_at timestamptz, updated_by text)`. Sobrevive a deploys.
 *   - Fallback: memória. Usado quando a tabela ainda não existe ou a
 *     Supabase está fora. Default = LIGADA.
 *
 * SQL recomendado (rodar 1x no Supabase SQL Editor):
 *
 *   CREATE TABLE IF NOT EXISTS app_settings (
 *     key text PRIMARY KEY,
 *     value jsonb NOT NULL DEFAULT '{}'::jsonb,
 *     updated_at timestamptz NOT NULL DEFAULT now(),
 *     updated_by text
 *   );
 *
 * Cache em memória: leituras do flushSession são quentes (várias por
 * minuto). Faço refresh do estado a cada AI_CONTROL_REFRESH_MS (default
 * 10s). Setar via API limpa o cache imediatamente.
 */

const AI_KEY = 'ai_enabled'
const DEFAULT_REFRESH_MS = 10_000

let cachedState = null
let cachedAtMs = 0
let supabaseUnavailable = false

function getSupabaseConfig(env) {
  const url = env.SUPABASE_URL && String(env.SUPABASE_URL).trim()
  const key = env.SUPABASE_KEY && String(env.SUPABASE_KEY).trim()
  if (!url || !key) return null
  return { url: url.replace(/\/$/, ''), key }
}

function refreshMs(env) {
  const v = Number(env.AI_CONTROL_REFRESH_MS)
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_REFRESH_MS
}

function defaultState() {
  return {
    enabled: true,
    updated_at: new Date(0).toISOString(),
    updated_by: 'default',
    reason: null,
    source: 'default',
  }
}

async function readFromSupabase(env) {
  const cfg = getSupabaseConfig(env)
  if (!cfg) return null
  try {
    const url = `${cfg.url}/rest/v1/app_settings?key=eq.${encodeURIComponent(AI_KEY)}&select=value,updated_at,updated_by`
    const r = await fetch(url, {
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    })
    if (r.status === 404 || r.status === 406) {
      // Tabela não existe ainda — marca como indisponível pra parar de tentar
      // a cada poll. A próxima escrita via setState tenta de novo (e o set
      // limpa essa flag se conseguir gravar).
      if (!supabaseUnavailable) {
        supabaseUnavailable = true
        console.warn(
          '[aiControlState] tabela app_settings não existe no Supabase. Operando em memória. ' +
            'Rode o SQL: CREATE TABLE app_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by text);',
        )
      }
      return null
    }
    if (!r.ok) {
      console.warn(`[aiControlState] read HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      return null
    }
    const rows = await r.json()
    if (!Array.isArray(rows) || rows.length === 0) return null
    const row = rows[0]
    const value = row.value || {}
    return {
      enabled: value.enabled !== false, // default true se vier sem o campo
      updated_at: row.updated_at,
      updated_by: row.updated_by || value.updated_by || null,
      reason: value.reason || null,
      source: 'supabase',
    }
  } catch (err) {
    console.warn(`[aiControlState] read err: ${err.message}`)
    return null
  }
}

async function writeToSupabase(env, { enabled, reason, by }) {
  const cfg = getSupabaseConfig(env)
  if (!cfg) return { ok: false, error: 'supabase_not_configured' }
  const url = `${cfg.url}/rest/v1/app_settings?on_conflict=key`
  const body = JSON.stringify([
    {
      key: AI_KEY,
      value: { enabled, reason: reason || null, updated_by: by || null },
      updated_at: new Date().toISOString(),
      updated_by: by || null,
    },
  ])
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body,
      signal: AbortSignal.timeout(5000),
    })
    if (r.status === 404 || r.status === 406) {
      supabaseUnavailable = true
      return { ok: false, error: 'table_missing', hint: 'create app_settings table' }
    }
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 300)
      return { ok: false, error: `http_${r.status}`, detail: txt }
    }
    supabaseUnavailable = false
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Lê o estado atual. Usa cache em memória com TTL pra não martelar a
 * Supabase a cada mensagem que chega. `force=true` ignora cache.
 */
export async function getState(env, { force = false } = {}) {
  const now = Date.now()
  if (!force && cachedState && now - cachedAtMs < refreshMs(env)) {
    return cachedState
  }
  let state = null
  if (!supabaseUnavailable) {
    state = await readFromSupabase(env)
  }
  if (!state) state = cachedState || defaultState()
  cachedState = state
  cachedAtMs = now
  return state
}

/**
 * Versão síncrona — devolve o último estado cacheado SEM ir ao Supabase.
 * Usado em hot paths (flushSession) onde a gente prefere disponibilidade
 * sobre frescor. O cache é atualizado pelo loop assíncrono em getState().
 */
export function getStateSync() {
  return cachedState || defaultState()
}

/**
 * Conveniência: true se a IA pode responder. Síncrono, lê do cache.
 */
export function isAiEnabled() {
  return getStateSync().enabled !== false
}

/**
 * Define o estado. Escreve na Supabase E atualiza cache. Retorna o estado
 * efetivamente persistido (ou só em memória se a Supabase falhou).
 */
export async function setState(env, { enabled, reason, by }) {
  const next = {
    enabled: enabled !== false,
    updated_at: new Date().toISOString(),
    updated_by: by || null,
    reason: reason || null,
    source: 'memory',
  }
  const w = await writeToSupabase(env, { enabled: next.enabled, reason: next.reason, by: next.updated_by })
  if (w.ok) {
    next.source = 'supabase'
  } else if (w.error === 'table_missing') {
    next.source = 'memory_table_missing'
  } else {
    next.source = `memory_${w.error || 'unknown'}`
  }
  cachedState = next
  cachedAtMs = Date.now()
  return next
}

/**
 * Inicializa: faz uma leitura no boot pra popular o cache. Não bloqueia
 * o boot se a Supabase tiver fora — só loga.
 */
export async function initAiControlState(env) {
  const s = await getState(env, { force: true })
  console.log(
    `[aiControlState] estado inicial: enabled=${s.enabled} source=${s.source}` +
      (s.reason ? ` reason="${s.reason}"` : '') +
      (s.updated_by ? ` by=${s.updated_by}` : ''),
  )
  return s
}
