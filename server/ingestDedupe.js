/**
 * Evita duas entradas idênticas no buffer da mesma sessão num intervalo curto
 * (ex.: mesma mensagem pelo webhook Evolution e pelo poll Kommo).
 */

import crypto from 'crypto'

/** @type {Map<string, number>} chave -> expireAt ms */
const store = new Map()

function normalizeForDedupe(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function ingestKey(sessionId, text) {
  const n = normalizeForDedupe(text)
  const h = crypto.createHash('sha256').update(n, 'utf8').digest('hex').slice(0, 24)
  return `${String(sessionId)}|${h}`
}

function prune(now = Date.now()) {
  for (const [k, ex] of store) {
    if (ex <= now) store.delete(k)
  }
}

export function shouldSkipDuplicateIngest(sessionId, text) {
  prune()
  const key = ingestKey(sessionId, text)
  const ex = store.get(key)
  return Boolean(ex && ex > Date.now())
}

export function recordIngestDedupe(sessionId, text, ttlMs) {
  const key = ingestKey(sessionId, text)
  store.set(key, Date.now() + ttlMs)
}

export function ingestDedupeEnabled(env) {
  const raw = String(env.MESSAGE_INGEST_DEDUPE_SEC ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  return true
}

export function ingestDedupeTtlMs(env) {
  const raw = String(env.MESSAGE_INGEST_DEDUPE_SEC ?? '').trim()
  const low = raw.toLowerCase()
  if (raw === '0' || low === 'false' || low === 'no' || low === 'off') return 0
  if (raw === '') return 120000
  const sec = Number(raw)
  if (Number.isFinite(sec) && sec > 0) return Math.floor(sec * 1000)
  return 120000
}
