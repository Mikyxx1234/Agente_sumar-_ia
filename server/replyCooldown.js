/**
 * Cooldown síncrono por telefone: evita segunda resposta em ticks seguidos do scheduler
 * quando o buffer ainda não foi limpo a tempo ou o claim distribuído falhou.
 */

import { normalizeTelefone } from './dadosClienteStore.js'

/** @type {Map<string, number>} telefone -> expireAt ms */
const recentReplyByPhone = new Map()

const DEFAULT_COOLDOWN_SEC = 45

/**
 * AGENT_REPLY_COOLDOWN_SEC:
 *   - undefined / vazio        → default 45s
 *   - número > 0               → usa esse valor
 *   - "0" (string ou número)   → DESLIGA o cooldown (markReplyCooldown vira no-op)
 *   - valor inválido / negativo → default 45s
 */
function resolveCooldownSec(env) {
  const raw = env?.AGENT_REPLY_COOLDOWN_SEC
  if (raw == null || String(raw).trim() === '') return DEFAULT_COOLDOWN_SEC
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_COOLDOWN_SEC
  if (n === 0) return 0
  if (n < 0) return DEFAULT_COOLDOWN_SEC
  return Math.floor(n)
}

export function isReplyCooldownDisabled(env) {
  return resolveCooldownSec(env) === 0
}

function prune(now = Date.now()) {
  for (const [k, ex] of recentReplyByPhone) {
    if (ex <= now) recentReplyByPhone.delete(k)
  }
}

export function shouldSkipReplyCooldown(env, telefone) {
  if (isReplyCooldownDisabled(env)) return false
  prune()
  const key = normalizeTelefone(telefone)
  if (!key) return false
  const ex = recentReplyByPhone.get(key)
  return Boolean(ex && ex > Date.now())
}

export function getReplyCooldownRemainingMs(env, telefone) {
  if (isReplyCooldownDisabled(env)) return 0
  const key = normalizeTelefone(telefone)
  if (!key) return 0
  const ex = recentReplyByPhone.get(key)
  if (!ex) return 0
  const remaining = ex - Date.now()
  return remaining > 0 ? remaining : 0
}

export function markReplyCooldown(env, telefone) {
  const sec = resolveCooldownSec(env)
  if (sec === 0) return
  const key = normalizeTelefone(telefone)
  if (!key) return
  recentReplyByPhone.set(key, Date.now() + sec * 1000)
}
