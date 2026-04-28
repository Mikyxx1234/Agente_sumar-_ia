/**
 * Buffer de mensagens do WhatsApp (equivalente aos nodes Redis do n8n).
 *
 * Três backends, escolhidos automaticamente (na ordem abaixo):
 *   1. Redis     (ioredis)   — se REDIS_URL ou REDIS_HOST estiver configurado
 *                              E a conexão inicial for bem-sucedida.
 *   2. Supabase  (REST)      — se SUPABASE_URL + SUPABASE_KEY estiverem setados.
 *                              Usa a tabela MESSAGE_BUFFER_TABLE (default:
 *                              message_buffer). Persiste, escala multi-réplica
 *                              e é fácil de inspecionar no painel.
 *   3. Memory    (Map)       — fallback: sem infra, não persiste em restart.
 *
 * Tabela esperada no backend Supabase:
 *   CREATE TABLE message_buffer (
 *     id bigserial PRIMARY KEY,
 *     session_id text NOT NULL,
 *     content text NOT NULL,
 *     created_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX message_buffer_session_id_idx ON message_buffer (session_id, id);
 *
 * Envs:
 *   REDIS_URL / REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_DB / REDIS_TLS / REDIS_KEY_PREFIX
 *   SUPABASE_URL / SUPABASE_KEY
 *   MESSAGE_BUFFER_TABLE=message_buffer
 *   MESSAGE_BUFFER_BACKEND=redis|supabase|memory  (força um backend específico)
 */

import Redis from 'ioredis'

const DEFAULT_KEY_PREFIX = 'wa:msg:'
const DEFAULT_LAST_TS_PREFIX = 'wa:msgts:'
const DEFAULT_TABLE = 'message_buffer'
const DEFAULT_TTL_SEC = 600 // 10 min — mensagens de leads que nunca entram no funil expiram sozinhas

let backendPromise = null

function getTtlSec(env) {
  const v = Number(env.MESSAGE_BUFFER_TTL_SEC)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_TTL_SEC
}

// ── Redis ────────────────────────────────────────────────────────────────

function hasRedisConfig(env) {
  return Boolean(env.REDIS_URL || env.REDIS_HOST)
}

function buildRedisClient(env) {
  const commonOpts = {
    lazyConnect: true,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => {
      // Para de tentar reconectar depois de 3 falhas — se o host
      // está inalcançável (rede Docker errada, etc.), não adianta
      // ficar batendo. Quem chamar uma operação no buffer vai pegar
      // erro e o auto-fallback do pickBackend cai pra Supabase.
      if (times > 3) return null
      return Math.min(times * 200, 2000)
    },
    connectTimeout: 3000,
    enableOfflineQueue: false,
  }
  if (env.REDIS_URL) return new Redis(env.REDIS_URL, commonOpts)
  return new Redis({
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    password: env.REDIS_PASSWORD || undefined,
    db: Number(env.REDIS_DB || 0),
    tls: String(env.REDIS_TLS || '').toLowerCase() === 'true' ? {} : undefined,
    ...commonOpts,
  })
}

function makeRedisBackend(env) {
  const client = buildRedisClient(env)
  const prefix = env.REDIS_KEY_PREFIX || DEFAULT_KEY_PREFIX
  const tsPrefix = (env.REDIS_KEY_PREFIX || '') + DEFAULT_LAST_TS_PREFIX
  const keyFor = (sid) => `${prefix}${sid}`
  const tsKeyFor = (sid) => `${tsPrefix}${sid}`
  const ttl = getTtlSec(env)

  client.on('error', (err) => {
    console.error('[MessageBuffer][Redis] error:', err.message)
  })

  return {
    label: 'redis',
    async init() {
      // connectTimeout cobre o connect, mas blindamos com Promise.race
      // pra garantir que nunca pendure o boot por mais de ~3.5s mesmo
      // com retry + DNS lento.
      await Promise.race([
        (async () => { await client.connect(); await client.ping() })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Redis init timeout (3500ms)')), 3500),
        ),
      ])
    },
    async push(sid, text) {
      const now = Date.now()
      const pipe = client.pipeline()
      pipe.rpush(keyFor(sid), String(text))
      pipe.expire(keyFor(sid), ttl)
      pipe.set(tsKeyFor(sid), String(now), 'EX', ttl)
      await pipe.exec()
    },
    async get(sid) {
      const items = await client.lrange(keyFor(sid), 0, -1)
      return Array.isArray(items) ? items : []
    },
    async lastTouchedAt(sid) {
      const v = await client.get(tsKeyFor(sid))
      const n = v != null ? Number(v) : NaN
      return Number.isFinite(n) ? new Date(n) : null
    },
    async clear(sid) {
      const pipe = client.pipeline()
      pipe.del(keyFor(sid))
      pipe.del(tsKeyFor(sid))
      const res = await pipe.exec()
      return Array.isArray(res) ? (res[0]?.[1] || 0) : 0
    },
    async ping() {
      return client.ping()
    },
  }
}

// ── Supabase ─────────────────────────────────────────────────────────────

function hasSupabaseConfig(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  return Boolean(url && key)
}

function makeSupabaseBackend(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  const table = env.MESSAGE_BUFFER_TABLE || DEFAULT_TABLE
  const base = `${url}/rest/v1/${encodeURIComponent(table)}`
  const headers = {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  }

  async function request(method, path, { body, prefer } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: prefer ? { ...headers, Prefer: prefer } : headers,
      body: body != null ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Supabase buffer ${method} ${res.status}: ${errText.slice(0, 200)}`)
    }
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }

  return {
    label: 'supabase',
    async init() {
      await request('GET', `?select=id&limit=1`)
    },
    async push(sid, text) {
      await request('POST', '', {
        body: { session_id: String(sid), content: String(text) },
        prefer: 'return=minimal',
      })
    },
    async get(sid) {
      const q = `?session_id=eq.${encodeURIComponent(sid)}&order=id.asc&select=content`
      const rows = await request('GET', q)
      if (!Array.isArray(rows)) return []
      return rows.map((r) => r.content).filter((c) => typeof c === 'string')
    },
    async lastTouchedAt(sid) {
      const q = `?session_id=eq.${encodeURIComponent(sid)}&order=created_at.desc&select=created_at&limit=1`
      const rows = await request('GET', q)
      if (!Array.isArray(rows) || !rows.length) return null
      const v = rows[0]?.created_at
      const d = v ? new Date(v) : null
      return d && !Number.isNaN(d.getTime()) ? d : null
    },
    async clear(sid) {
      const q = `?session_id=eq.${encodeURIComponent(sid)}`
      await request('DELETE', q, { prefer: 'return=minimal' })
      return 1
    },
    async ping() {
      await request('GET', `?select=id&limit=1`)
      return 'PONG'
    },
  }
}

// ── Memory ───────────────────────────────────────────────────────────────

function makeMemoryBackend(env) {
  const store = new Map() // sid -> string[]
  const tsStore = new Map() // sid -> Date
  const ttlMs = getTtlSec(env) * 1000

  function pruneIfExpired(sid) {
    const ts = tsStore.get(sid)
    if (ts && Date.now() - ts.getTime() > ttlMs) {
      store.delete(sid)
      tsStore.delete(sid)
    }
  }

  return {
    label: 'memory',
    async init() {},
    async push(sid, text) {
      pruneIfExpired(sid)
      const list = store.get(sid) || []
      list.push(String(text))
      store.set(sid, list)
      tsStore.set(sid, new Date())
    },
    async get(sid) {
      pruneIfExpired(sid)
      return (store.get(sid) || []).slice()
    },
    async lastTouchedAt(sid) {
      pruneIfExpired(sid)
      return tsStore.get(sid) || null
    },
    async clear(sid) {
      store.delete(sid)
      tsStore.delete(sid)
      return 1
    },
    async ping() {
      return 'PONG'
    },
  }
}

// ── Seleção ──────────────────────────────────────────────────────────────

async function tryInit(backend) {
  await backend.init()
  return backend
}

async function pickBackend(env) {
  const forced = String(env.MESSAGE_BUFFER_BACKEND || '').toLowerCase()

  if (forced === 'memory') {
    console.warn('[MessageBuffer] forçado memory → buffer em memória (não persistente)')
    return makeMemoryBackend(env)
  }

  if (forced === 'redis') {
    return tryInit(makeRedisBackend(env)).then((b) => {
      console.log('[MessageBuffer] backend=redis (forçado)')
      return b
    })
  }

  if (forced === 'supabase') {
    return tryInit(makeSupabaseBackend(env)).then((b) => {
      console.log('[MessageBuffer] backend=supabase (forçado)')
      return b
    })
  }

  if (hasRedisConfig(env)) {
    try {
      const b = await tryInit(makeRedisBackend(env))
      console.log('[MessageBuffer] backend=redis (auto)')
      return b
    } catch (err) {
      console.warn(`[MessageBuffer] Redis indisponível (${err.message}) → tentando Supabase`)
    }
  }

  if (hasSupabaseConfig(env)) {
    try {
      const b = await tryInit(makeSupabaseBackend(env))
      console.log('[MessageBuffer] backend=supabase (auto)')
      return b
    } catch (err) {
      console.warn(`[MessageBuffer] Supabase indisponível (${err.message}) → caindo para memória`)
    }
  }

  console.warn('[MessageBuffer] nenhum backend externo disponível → usando buffer em memória (não persistente)')
  return makeMemoryBackend(env)
}

async function getBackend(env) {
  if (!backendPromise) {
    backendPromise = pickBackend(env).catch((err) => {
      backendPromise = null
      throw err
    })
  }
  return backendPromise
}

// ── API pública ──────────────────────────────────────────────────────────

export async function pushMessage(env, sessionId, text) {
  if (!sessionId || !text) return
  const backend = await getBackend(env)
  await backend.push(sessionId, text)
}

export async function getMessages(env, sessionId) {
  if (!sessionId) return []
  const backend = await getBackend(env)
  return backend.get(sessionId)
}

export async function clearMessages(env, sessionId) {
  if (!sessionId) return 0
  const backend = await getBackend(env)
  return backend.clear(sessionId)
}

/**
 * Timestamp da última mensagem inserida no buffer dessa sessão.
 * Usado pelo agentScheduler pra aplicar o debounce: só processa quem ficou
 * silencioso por X segundos após a última mensagem.
 *
 * @returns {Promise<Date|null>}
 */
export async function getLastTouchedAt(env, sessionId) {
  if (!sessionId) return null
  const backend = await getBackend(env)
  if (typeof backend.lastTouchedAt !== 'function') return null
  return backend.lastTouchedAt(sessionId)
}

export async function pingBackend(env) {
  const backend = await getBackend(env)
  return { backend: backend.label, pong: await backend.ping() }
}
