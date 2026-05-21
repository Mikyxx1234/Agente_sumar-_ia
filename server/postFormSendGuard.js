/**
 * Evita reenviar a mensagem pós-formulário no mesmo telefone (réplicas / race no claim).
 */

import { normalizeTelefone } from './dadosClienteStore.js'
import { isPostFormRegistradoBoilerplate } from './dadosClienteInscricaoFields.js'

const memory = new Map()

function ttlMs(env) {
  const h = Number(env.POST_FORM_SEND_GUARD_HOURS)
  const hours = Number.isFinite(h) && h > 0 ? h : 72
  return Math.floor(hours * 3600000)
}

export function isPostFormOutboundText(text) {
  return isPostFormRegistradoBoilerplate(text)
}

/**
 * @returns {boolean} true se pode enviar
 */
export function tryClaimPostFormSend(telefone, env = process.env) {
  const key = normalizeTelefone(telefone)
  if (!key) return true
  const now = Date.now()
  const ex = memory.get(key)
  if (ex && ex > now) return false
  memory.set(key, now + ttlMs(env))
  return true
}

export function releasePostFormSendClaim(telefone) {
  const key = normalizeTelefone(telefone)
  if (key) memory.delete(key)
}
