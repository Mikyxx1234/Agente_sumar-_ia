/**
 * Cooldown síncrono por telefone: evita segunda resposta em ticks seguidos do scheduler
 * quando o buffer ainda não foi limpo a tempo ou o claim distribuído falhou.
 */

import { normalizeTelefone } from './dadosClienteStore.js'

/** @type {Map<string, number>} telefone -> expireAt ms */
const recentReplyByPhone = new Map()

function resolveCooldownSec(env) {
  const n = Number(env.AGENT_REPLY_COOLDOWN_SEC)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 45
}

function prune(now = Date.now()) {
  for (const [k, ex] of recentReplyByPhone) {
    if (ex <= now) recentReplyByPhone.delete(k)
  }
}

export function shouldSkipReplyCooldown(env, telefone) {
  prune()
  const key = normalizeTelefone(telefone)
  if (!key) return false
  const ex = recentReplyByPhone.get(key)
  return Boolean(ex && ex > Date.now())
}

export function markReplyCooldown(env, telefone) {
  const key = normalizeTelefone(telefone)
  if (!key) return
  const sec = resolveCooldownSec(env)
  recentReplyByPhone.set(key, Date.now() + sec * 1000)
}
