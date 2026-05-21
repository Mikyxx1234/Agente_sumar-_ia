/**
 * Evita reenviar "Obrigado! Registramos o formulário..." — lock Redis + claim
 * atômico por id da linha (evita 2 PATCHs em linhas duplicadas no Supabase).
 */

import { fetchDadosClienteByTelefone, normalizeTelefone } from './dadosClienteStore.js'
import { getMessageBufferRedis } from './evolution/messageBuffer.js'
import { isPostFormRegistradoBoilerplate } from './dadosClienteInscricaoFields.js'
import {
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  matriculaPosFormAlreadyProcessed,
} from '../libShared/inscricaoFormHeuristics.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'
const CLIENTE_POST_FORM_SELECT = 'id,telefone,inscricao_form_status,inscricao_form_recebido_at'

/** Lock síncrono no processo (antes do primeiro await). */
const syncInflight = new Map()

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum',
  }
}

function guardTtlSec(env) {
  const sec = Number(env.POST_FORM_SEND_GUARD_SEC)
  return Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 300
}

function tryReservePostFormSendSync(telefone) {
  const key = normalizeTelefone(telefone)
  if (!key) return false
  const now = Date.now()
  const ex = syncInflight.get(key)
  if (ex && ex > now) return false
  syncInflight.set(key, now + 90_000)
  return true
}

function releasePostFormSendSync(telefone) {
  const key = normalizeTelefone(telefone)
  if (key) syncInflight.delete(key)
}

async function tryRedisPostFormLock(env, telefone) {
  const digits = normalizeTelefone(telefone)
  if (!digits) return { ok: false, reason: 'invalid_phone' }
  try {
    const { client, keyPrefix } = await getMessageBufferRedis(env)
    if (!client) return { ok: true, reason: 'no_redis' }
    const key = `${keyPrefix || 'wa:msg:'}postform:send:${digits}`
    const ttl = guardTtlSec(env)
    const res = await client.set(key, String(Date.now()), 'EX', ttl, 'NX')
    if (res === 'OK') return { ok: true, reason: 'redis_nx' }
    return { ok: false, reason: 'redis_busy' }
  } catch (err) {
    console.warn('[postFormSendGuard] redis lock falhou:', err.message)
    return { ok: true, reason: 'redis_error_allow' }
  }
}

/**
 * Claim distribuído: só quem grava `inscricao_form_recebido_at` (ainda null) na linha do cliente pode enviar.
 * @returns {Promise<{ allow: boolean, reason: string }>}
 */
export async function tryClaimPostFormWhatsappSend(env, telefone) {
  const digits = normalizeTelefone(telefone)
  if (!digits) return { allow: false, reason: 'invalid_phone' }

  if (!tryReservePostFormSendSync(telefone)) {
    return { allow: false, reason: 'sync_inflight_busy' }
  }

  try {
    const row = await fetchDadosClienteByTelefone(env, telefone, CLIENTE_POST_FORM_SELECT)
    if (matriculaPosFormAlreadyProcessed(row)) {
      return { allow: false, reason: 'already_processed_supabase' }
    }
    const rowId = row?.id != null ? Number(row.id) : NaN
    if (!Number.isFinite(rowId) || rowId <= 0) {
      return { allow: false, reason: 'no_cliente_row' }
    }

    const redisLock = await tryRedisPostFormLock(env, telefone)
    if (!redisLock.ok) {
      return { allow: false, reason: redisLock.reason }
    }

    const { url, key: supKey, table } = getSupabaseCfg(env)
    if (!url || !supKey) {
      return { allow: false, reason: 'no_supabase' }
    }

    const recebidoAt = new Date().toISOString()
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?id=eq.${rowId}&inscricao_form_recebido_at=is.null`,
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
        `[postFormSendGuard] claim_send patch_${res.status} id=${rowId} ${errBody.slice(0, 120)}`,
      )
      return { allow: false, reason: `patch_${res.status}` }
    }
    const rows = await res.json()
    if (Array.isArray(rows) && rows.length === 1) {
      return { allow: true, reason: 'claimed_send_slot' }
    }
    if (Array.isArray(rows) && rows.length === 0) {
      const again = await fetchDadosClienteByTelefone(env, telefone, CLIENTE_POST_FORM_SELECT)
      if (matriculaPosFormAlreadyProcessed(again)) {
        return { allow: false, reason: 'send_slot_taken_after_race' }
      }
    }
    return { allow: false, reason: 'send_slot_taken' }
  } catch (err) {
    console.warn(`[postFormSendGuard] claim_send error telefone=${digits}:`, err.message)
    return { allow: false, reason: 'claim_error' }
  } finally {
    releasePostFormSendSync(telefone)
  }
}

export function isPostFormOutboundText(text) {
  return isPostFormRegistradoBoilerplate(text)
}
