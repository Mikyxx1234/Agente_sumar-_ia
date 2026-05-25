/**
 * Evita reprocessar o mesmo conteúdo do buffer em ticks seguidos do scheduler
 * (eco Kommo / fallback WABA reempurrando texto já respondido).
 */

import crypto from 'crypto'
import { getMessageBufferRedis } from './evolution/messageBuffer.js'

const mem = new Map()

function hashInbound(items) {
  const norm = (items || [])
    .map((x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean)
    .join('|')
  if (!norm) return ''
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 32)
}

function memKey(sessionId) {
  return String(sessionId || '').trim()
}

/**
 * @returns {Promise<{ skip: boolean, reason?: string }>}
 */
export async function shouldSkipStaleBufferFlush(env, sessionId, messages) {
  const sid = memKey(sessionId)
  if (!sid) return { skip: false }
  const h = hashInbound(messages)
  if (!h) return { skip: false }

  const { client, keyPrefix } = await getMessageBufferRedis(env).catch(() => ({
    client: null,
    keyPrefix: 'wa:msg:',
  }))
  const redisKey = `${keyPrefix || 'wa:msg:'}flush:hash:v1:${sid}`

  if (client) {
    try {
      if (client.status === 'wait') await client.connect()
      const prev = await client.get(redisKey)
      if (prev && prev === h) {
        return { skip: true, reason: 'same_buffer_hash_redis' }
      }
    } catch (err) {
      console.warn('[sessionFlushDedupe] redis get falhou:', err.message)
    }
  } else {
    const prev = mem.get(sid)
    if (prev && prev.hash === h) {
      return { skip: true, reason: 'same_buffer_hash_mem' }
    }
  }

  return { skip: false }
}

export async function recordBufferFlushHash(env, sessionId, messages) {
  const sid = memKey(sessionId)
  const h = hashInbound(messages)
  if (!sid || !h) return

  const ttlSec = Number(env.AGENT_FLUSH_HASH_TTL_SEC)
  const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : 3600

  mem.set(sid, { hash: h, at: Date.now() })

  const { client, keyPrefix } = await getMessageBufferRedis(env).catch(() => ({
    client: null,
    keyPrefix: 'wa:msg:',
  }))
  if (!client) return
  const redisKey = `${keyPrefix || 'wa:msg:'}flush:hash:v1:${sid}`
  try {
    if (client.status === 'wait') await client.connect()
    await client.set(redisKey, h, 'EX', ttl)
  } catch (err) {
    console.warn('[sessionFlushDedupe] redis set falhou:', err.message)
  }
}

/**
 * Descarta buffer repetido e evita loop de IA sem inbound novo do lead.
 */
export async function clearBufferIfStaleRepush(env, sessionId, messages) {
  const gate = await shouldSkipStaleBufferFlush(env, sessionId, messages)
  if (!gate.skip) return gate
  const { clearMessages } = await import('./evolution/messageBuffer.js')
  const cleared = await clearMessages(env, sessionId)
  console.log(
    `[scheduler] buffer stale ignorado session=${sessionId} reason=${gate.reason} cleared=${cleared}`,
  )
  return gate
}
