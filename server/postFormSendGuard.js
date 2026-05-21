/**
 * Evita reenviar "Obrigado! Registramos o formulário..." — claim atômico no Supabase
 * (funciona entre réplicas; o guard em memória sozinho não).
 */

import {
  fetchDadosClienteByTelefone,
  dadosClienteTelefoneOrFilter,
  normalizeTelefone,
} from './dadosClienteStore.js'
import { isPostFormRegistradoBoilerplate } from './dadosClienteInscricaoFields.js'
import {
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  matriculaPosFormAlreadyProcessed,
} from '../libShared/inscricaoFormHeuristics.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'
const memory = new Map()

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum',
  }
}

function memoryTtlMs(env) {
  const sec = Number(env.POST_FORM_SEND_GUARD_SEC)
  return Number.isFinite(sec) && sec > 0 ? Math.floor(sec * 1000) : 120_000
}

/**
 * Claim distribuído: só quem grava `inscricao_form_recebido_at` (ainda null) pode enviar o texto padrão.
 * @returns {Promise<{ allow: boolean, reason: string }>}
 */
export async function tryClaimPostFormWhatsappSend(env, telefone) {
  const key = normalizeTelefone(telefone)
  if (!key) return { allow: false, reason: 'invalid_phone' }

  const now = Date.now()
  const memEx = memory.get(key)
  if (memEx && memEx > now) {
    return { allow: false, reason: 'memory_guard_recent' }
  }

  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    'telefone,inscricao_form_status,inscricao_form_recebido_at',
  )
  if (matriculaPosFormAlreadyProcessed(row)) {
    return { allow: false, reason: 'already_processed_supabase' }
  }

  const { url, key: supKey, table } = getSupabaseCfg(env)
  const telFilter = dadosClienteTelefoneOrFilter(telefone)
  if (!url || !supKey || !telFilter) {
    return { allow: true, reason: 'no_supabase_claim_skipped' }
  }

  const recebidoAt = new Date().toISOString()
  try {
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?${telFilter}&inscricao_form_recebido_at=is.null`,
      {
        method: 'PATCH',
        headers: {
          apikey: supKey,
          Authorization: `Bearer ${supKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          inscricao_form_recebido_at: recebidoAt,
          [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_CONCLUIDO,
        }),
      },
    )
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.warn(
        `[postFormSendGuard] claim_send patch_${res.status} telefone=${key} ${errBody.slice(0, 120)}`,
      )
      return { allow: false, reason: `patch_${res.status}` }
    }
    const rows = await res.json()
    if (Array.isArray(rows) && rows.length > 0) {
      memory.set(key, now + memoryTtlMs(env))
      return { allow: true, reason: 'claimed_send_slot' }
    }
    return { allow: false, reason: 'send_slot_taken' }
  } catch (err) {
    console.warn(`[postFormSendGuard] claim_send error telefone=${key}:`, err.message)
    return { allow: false, reason: 'claim_error' }
  }
}

export function isPostFormOutboundText(text) {
  return isPostFormRegistradoBoilerplate(text)
}

/** @deprecated Use tryClaimPostFormWhatsappSend no sender. */
export function tryClaimPostFormSend(telefone, env = process.env) {
  const key = normalizeTelefone(telefone)
  if (!key) return true
  const now = Date.now()
  const ex = memory.get(key)
  if (ex && ex > now) return false
  memory.set(key, now + memoryTtlMs(env))
  return true
}

export function releasePostFormSendClaim(telefone) {
  const key = normalizeTelefone(telefone)
  if (key) memory.delete(key)
}
