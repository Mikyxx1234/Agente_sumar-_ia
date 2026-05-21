/**
 * Garante que só um flush+IA processe a mesma sessão por vez.
 * Ordem: lock síncrono (processo) → Redis NX → Supabase PATCH → memória.
 */

import {
  dadosClienteTelefoneOrFilter,
  normalizeTelefone,
} from './dadosClienteStore.js'

const FIELD_FLUSH_CLAIM = 'agent_flush_claim_at'

/** Lock imediato no processo — evita corrida antes do primeiro await. */
const syncFlushLocks = new Map()

/** @type {Map<string, number>} sessionId -> expireAt ms (fallback async) */
const memoryClaims = new Map()

function flushClaimEnabled(env) {
  const raw = String(env.AGENT_FLUSH_CLAIM_ENABLED ?? 'true').trim().toLowerCase()
  return !['false', '0', 'no', 'off'].includes(raw)
}

function flushClaimTtlSec(env) {
  const n = Number(env.AGENT_FLUSH_CLAIM_SEC)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90
}

function pruneMemoryClaims(now = Date.now()) {
  for (const [k, ex] of memoryClaims) {
    if (ex <= now) memoryClaims.delete(k)
  }
}

/**
 * Reserva flush no processo atual (síncrono). Chamar antes de qualquer await.
 */
export function tryReserveFlushSync(sessionId, env) {
  if (!flushClaimEnabled(env)) return true
  const key = String(sessionId || '').trim()
  if (!key) return false
  const now = Date.now()
  const ttlMs = flushClaimTtlSec(env) * 1000
  const ex = syncFlushLocks.get(key)
  if (ex && ex > now) return false
  syncFlushLocks.set(key, now + ttlMs)
  return true
}

export function releaseFlushSync(sessionId) {
  const key = String(sessionId || '').trim()
  if (key) syncFlushLocks.delete(key)
}

function tryMemoryClaim(sessionId, ttlSec) {
  pruneMemoryClaims()
  const key = String(sessionId || '').trim()
  if (!key) return false
  const now = Date.now()
  const ex = memoryClaims.get(key)
  if (ex && ex > now) return false
  memoryClaims.set(key, now + ttlSec * 1000)
  return true
}

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum',
  }
}

async function tryDadosClienteFlushClaim(env, telefone, ttlSec) {
  const { url, key, table } = getSupabaseCfg(env)
  const telFilter = dadosClienteTelefoneOrFilter(telefone)
  if (!url || !key || !telFilter) return false
  const nowIso = new Date().toISOString()
  const cutoff = new Date(Date.now() - ttlSec * 1000).toISOString()
  try {
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?${telFilter}&or=(${FIELD_FLUSH_CLAIM}.is.null,${FIELD_FLUSH_CLAIM}.lt.${encodeURIComponent(cutoff)})`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ [FIELD_FLUSH_CLAIM]: nowIso }),
      },
    )
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    return res.ok && Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}

/**
 * Claim distribuído (Redis / Supabase). Chamar após tryReserveFlushSync.
 */
export async function tryClaimAgentFlush(env, { sessionId, telefone, redisClient, redisKeyPrefix }) {
  if (!flushClaimEnabled(env)) return { claimed: true }

  const sid = String(sessionId || '').trim()
  if (!sid) return { claimed: false, reason: 'missing_session' }

  const ttlSec = flushClaimTtlSec(env)
  const prefix = redisKeyPrefix || env.REDIS_KEY_PREFIX || 'wa:msg:'
  const claimKey = `${prefix}flush:claim:${sid}`

  if (redisClient) {
    try {
      const ok = await redisClient.set(claimKey, String(Date.now()), 'EX', ttlSec, 'NX')
      if (ok === 'OK') return { claimed: true }
      return { claimed: false, reason: 'redis_claim_busy' }
    } catch (err) {
      console.warn('[flushClaim] redis claim falhou:', err.message)
    }
  }

  const fone = normalizeTelefone(telefone || sid)
  if (fone) {
    const dc = await tryDadosClienteFlushClaim(env, fone, ttlSec)
    if (dc) return { claimed: true }
  }

  if (tryMemoryClaim(sid, ttlSec)) return { claimed: true }

  return { claimed: false, reason: 'claim_busy' }
}
