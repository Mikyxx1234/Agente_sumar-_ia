/**
 * Evita reenviar "Obrigado! Registramos o formulário..." — Supabase + Redis + notas Kommo.
 */

import { fetchDadosClienteByTelefone, normalizeTelefone } from './dadosClienteStore.js'
import { getMessageBufferRedis } from './evolution/messageBuffer.js'
import { listLeadNotes } from './kommoClient.js'
import { isPostFormRegistradoBoilerplate } from './dadosClienteInscricaoFields.js'
import {
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  matriculaPosFormAlreadyProcessed,
} from '../libShared/inscricaoFormHeuristics.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'
const CLIENTE_POST_FORM_SELECT = 'id,telefone,inscricao_form_status,inscricao_form_recebido_at'

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

function requireRedisLock(env) {
  const raw = String(env.POST_FORM_SEND_REQUIRE_REDIS ?? 'true').trim().toLowerCase()
  return !['false', '0', 'no', 'off'].includes(raw)
}

export function tryReservePostFormSendSync(telefone) {
  const key = normalizeTelefone(telefone)
  if (!key) return false
  const now = Date.now()
  const ex = syncInflight.get(key)
  if (ex && ex > now) return false
  syncInflight.set(key, now + 90_000)
  return true
}

export function releasePostFormSendSync(telefone) {
  const key = normalizeTelefone(telefone)
  if (key) syncInflight.delete(key)
}

function noteText(n) {
  return [n?.params?.text, n?.params?.message, n?.text].filter(Boolean).join(' ').trim()
}

/**
 * Já existe nota no Kommo com o texto padrão (independente do Supabase).
 */
export async function leadHasPostFormRegistradoNote(env, leadId) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) return false
  try {
    const notesRes = await listLeadNotes(env, id, { limit: 50, order: 'desc' })
    if (!notesRes.ok || !Array.isArray(notesRes.notes)) return false
    for (const n of notesRes.notes) {
      if (isPostFormRegistradoBoilerplate(noteText(n))) return true
    }
  } catch (err) {
    console.warn(`[postFormSendGuard] leadHasPostFormRegistradoNote lead=${id}:`, err.message)
  }
  return false
}

async function tryRedisPostFormLock(env, telefone) {
  const digits = normalizeTelefone(telefone)
  if (!digits) return { ok: false, reason: 'invalid_phone' }
  try {
    const { client, keyPrefix } = await getMessageBufferRedis(env)
    if (!client) {
      return requireRedisLock(env)
        ? { ok: false, reason: 'redis_required_missing' }
        : { ok: true, reason: 'no_redis' }
    }
    const key = `${keyPrefix || 'wa:msg:'}postform:send:v2:${digits}`
    const ttl = guardTtlSec(env)
    const res = await client.set(key, String(Date.now()), 'EX', ttl, 'NX')
    if (res === 'OK') return { ok: true, reason: 'redis_nx' }
    return { ok: false, reason: 'redis_busy' }
  } catch (err) {
    console.warn('[postFormSendGuard] redis lock falhou:', err.message)
    return requireRedisLock(env)
      ? { ok: false, reason: 'redis_error' }
      : { ok: true, reason: 'redis_error_allow' }
  }
}

/**
 * @param {{ holdSyncLock?: boolean }} [opts] — caller libera sync após envio com holdSyncLock=true
 */
export async function tryClaimPostFormWhatsappSend(env, telefone, opts = {}) {
  const digits = normalizeTelefone(telefone)
  if (!digits) return { allow: false, reason: 'invalid_phone' }

  if (!tryReservePostFormSendSync(telefone)) {
    return { allow: false, reason: 'sync_inflight_busy' }
  }

  const holdSync = Boolean(opts.holdSyncLock)

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
    const again = await fetchDadosClienteByTelefone(env, telefone, CLIENTE_POST_FORM_SELECT)
    if (matriculaPosFormAlreadyProcessed(again)) {
      return { allow: false, reason: 'send_slot_taken_after_race' }
    }
    return { allow: false, reason: 'send_slot_taken' }
  } catch (err) {
    console.warn(`[postFormSendGuard] claim_send error telefone=${digits}:`, err.message)
    return { allow: false, reason: 'claim_error' }
  } finally {
    if (!holdSync) releasePostFormSendSync(telefone)
  }
}

export function isPostFormOutboundText(text) {
  return isPostFormRegistradoBoilerplate(text)
}
