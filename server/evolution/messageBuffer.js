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
import {
  ingestDedupeEnabled,
  ingestDedupeTtlMs,
  shouldSkipDuplicateIngest,
  recordIngestDedupe,
} from '../ingestDedupe.js'
import { getStateSync as getAiControlStateSync } from '../aiControlState.js'
import { canonicalWhatsAppSessionId } from '../phoneWhatsApp.js'

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
    _client: client,
    async dispose() {
      try {
        client.removeAllListeners()
        await client.quit()
      } catch {
        try { client.disconnect() } catch { /* ignore */ }
      }
    },
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
    /** LRANGE + DEL atômico — só um flush consome a fila. */
    async drain(sid) {
      const key = keyFor(sid)
      const res = await client
        .multi()
        .lrange(key, 0, -1)
        .del(key)
        .del(tsKeyFor(sid))
        .exec()
      const items = res?.[0]?.[1]
      return Array.isArray(items) ? items.map(String) : []
    },
    async ping() {
      return client.ping()
    },
    /**
     * Sessões com pelo menos 1 mensagem na fila (SCAN — uso moderado).
     * @param {number} limit
     * @returns {Promise<string[]>}
     */
    flushClaimKey(sid) {
      return `${prefix}flush:claim:${sid}`
    },
    getRedisClient() {
      return client
    },
    getKeyPrefix() {
      return prefix
    },
    async listPendingSessionIds(limit) {
      const cap = Math.max(1, Math.min(200, Number(limit) || 50))
      const pattern = `${prefix}*`
      const seen = new Set()
      let cursor = '0'
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 80)
        cursor = String(next)
        for (const key of keys || []) {
          if (typeof key !== 'string' || !key.startsWith(prefix)) continue
          const sid = key.slice(prefix.length)
          if (!sid || seen.has(sid)) continue
          const n = await client.llen(key)
          if (n > 0) {
            seen.add(sid)
            if (seen.size >= cap) return [...seen]
          }
        }
      } while (cursor !== '0')
      return [...seen]
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
      // Valida tabela + colunas usadas em push/get/list (evita backend "supabase"
      // com init falso quando a tabela não existe no PostgREST).
      await request('GET', `?select=id,session_id,content&limit=1`)
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
    async drain(sid) {
      const enc = encodeURIComponent(String(sid))
      const q = `?session_id=eq.${enc}&order=id.asc&select=content`
      const rows = await request('GET', q)
      if (!Array.isArray(rows) || !rows.length) return []
      await request('DELETE', `?session_id=eq.${enc}`, { prefer: 'return=minimal' })
      return rows.map((r) => String(r.content || '')).filter(Boolean)
    },
    async ping() {
      await request('GET', `?select=id&limit=1`)
      return 'PONG'
    },
    /**
     * Distinct session_id entre linhas recentes (heurística p/ scheduler órfão).
     * @param {number} limit
     * @returns {Promise<string[]>}
     */
    async listPendingSessionIds(limit) {
      const cap = Math.max(1, Math.min(100, Number(limit) || 30))
      const scan = Math.min(3000, cap * 80)
      const q = `?select=session_id&order=id.desc&limit=${scan}`
      const rows = await request('GET', q)
      if (!Array.isArray(rows)) return []
      const uniq = []
      const seen = new Set()
      for (const r of rows) {
        const sid = r?.session_id
        if (typeof sid !== 'string' || !sid || seen.has(sid)) continue
        seen.add(sid)
        uniq.push(sid)
        if (uniq.length >= cap) break
      }
      const withMsgs = []
      for (const sid of uniq) {
        const items = await this.get(sid)
        if (items && items.length) withMsgs.push(sid)
        if (withMsgs.length >= cap) break
      }
      return withMsgs
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
    async drain(sid) {
      pruneIfExpired(sid)
      const list = (store.get(sid) || []).slice()
      store.delete(sid)
      tsStore.delete(sid)
      return list.map(String)
    },
    async ping() {
      return 'PONG'
    },
    /** @param {number} limit */
    async listPendingSessionIds(limit) {
      const cap = Math.max(1, Math.min(200, Number(limit) || 50))
      const out = []
      for (const [sid, list] of store.entries()) {
        if (list && list.length > 0) {
          out.push(sid)
          if (out.length >= cap) break
        }
      }
      return out
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
    const redisBackend = makeRedisBackend(env)
    try {
      const b = await tryInit(redisBackend)
      console.log('[MessageBuffer] backend=redis (forçado)')
      return b
    } catch (err) {
      await redisBackend.dispose?.().catch(() => {})
      console.warn(`[MessageBuffer] Redis forçado falhou (${err.message}) → memória`)
      return makeMemoryBackend(env)
    }
  }

  if (forced === 'supabase') {
    try {
      const b = await tryInit(makeSupabaseBackend(env))
      console.log('[MessageBuffer] backend=supabase (forçado)')
      return b
    } catch (err) {
      console.warn(`[MessageBuffer] Supabase forçado falhou (${err.message}) → memória`)
      return makeMemoryBackend(env)
    }
  }

  if (hasRedisConfig(env)) {
    const redisBackend = makeRedisBackend(env)
    try {
      const b = await tryInit(redisBackend)
      console.log('[MessageBuffer] backend=redis (auto)')
      return b
    } catch (err) {
      await redisBackend.dispose?.().catch(() => {})
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

/**
 * @param {Record<string,string>} env
 * @param {string} sessionId
 * @param {string} text
 * @param {{ skipDedupe?: boolean }} [opts] — Playground / testes: skipDedupe=true
 */
function resolveBufferSessionId(sessionId) {
  return canonicalWhatsAppSessionId(sessionId) || String(sessionId || '').trim() || null
}

export async function pushMessage(env, sessionId, text, opts = {}) {
  const sid = resolveBufferSessionId(sessionId)
  if (!sid || !text) return { pushed: false, skipped: 'invalid_args' }
  // Kill switch: IA desligada → DESCARTA na entrada. Mensagem nem
  // chega no buffer, então ao religar não há backlog pra processar
  // (comportamento "responde só novas após religar"). O playground/teste
  // pode usar opts.bypassAiSwitch=true pra ignorar essa trava.
  if (!opts.bypassAiSwitch) {
    const aiState = getAiControlStateSync()
    if (aiState.enabled === false) {
      return { pushed: false, skipped: 'ai_disabled' }
    }
  }
  const skipDedupe = opts.skipDedupe === true
  if (!skipDedupe && ingestDedupeEnabled(env)) {
    const ttlMs = ingestDedupeTtlMs(env)
    if (ttlMs > 0 && shouldSkipDuplicateIngest(sid, text)) {
      return { pushed: false, skipped: 'ingest_dedupe' }
    }
  }
  const backend = await getBackend(env)
  await backend.push(sid, text)
  if (!skipDedupe && ingestDedupeEnabled(env)) {
    const ttlMs = ingestDedupeTtlMs(env)
    if (ttlMs > 0) recordIngestDedupe(sid, text, ttlMs)
  }
  return { pushed: true }
}

export async function getMessages(env, sessionId) {
  const sid = resolveBufferSessionId(sessionId)
  if (!sid) return []
  const backend = await getBackend(env)
  return backend.get(sid)
}

/**
 * Remove e devolve todas as mensagens pendentes (consumo único no flush).
 */
export async function drainMessages(env, sessionId) {
  const sid = resolveBufferSessionId(sessionId)
  if (!sid) return []
  const backend = await getBackend(env)
  if (typeof backend.drain === 'function') {
    return backend.drain(sid)
  }
  const items = await backend.get(sid)
  await backend.clear(sid)
  return items
}

export async function clearMessages(env, sessionId) {
  const sid = resolveBufferSessionId(sessionId)
  if (!sid) return 0
  const backend = await getBackend(env)
  return backend.clear(sid)
}

/**
 * Timestamp da última mensagem inserida no buffer dessa sessão.
 * Usado pelo agentScheduler pra aplicar o debounce: só processa quem ficou
 * silencioso por X segundos após a última mensagem.
 *
 * @returns {Promise<Date|null>}
 */
export async function getLastTouchedAt(env, sessionId) {
  const sid = resolveBufferSessionId(sessionId)
  if (!sid) return null
  const backend = await getBackend(env)
  if (typeof backend.lastTouchedAt !== 'function') return null
  return backend.lastTouchedAt(sid)
}

export async function pingBackend(env) {
  const backend = await getBackend(env)
  return { backend: backend.label, pong: await backend.ping() }
}

/**
 * Lista session_ids que têm mensagens pendentes no buffer (p/ scheduler
 * quando o funil Kommo está vazio mas o webhook Evolution encheu fila).
 *
 * @param {Record<string,string>} env
 * @param {number} [limit=30]
 * @returns {Promise<string[]>}
 */
export async function listSessionsWithPendingMessages(env, limit = 30) {
  const backend = await getBackend(env)
  if (typeof backend.listPendingSessionIds !== 'function') return []
  return backend.listPendingSessionIds(limit)
}

/** Expõe cliente Redis do buffer (claim de flush multi-réplica). */
export async function getMessageBufferRedis(env) {
  const backend = await getBackend(env)
  if (backend.label !== 'redis' || typeof backend.getRedisClient !== 'function') {
    return { client: null, keyPrefix: env.REDIS_KEY_PREFIX || DEFAULT_KEY_PREFIX }
  }
  return { client: backend.getRedisClient(), keyPrefix: backend.getKeyPrefix() }
}
