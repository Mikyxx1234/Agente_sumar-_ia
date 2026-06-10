/**
 * Espelha mensagens inbound do WhatsApp (Evolution) no timeline do Kommo.
 *
 * Sem isso, o agente processa via webhook Evolution mas o CRM só mostra as
 * respostas da IA (notas common) — as falas do candidato ficam invisíveis.
 */

import { createLeadSmsInNote, findLeadByPhone } from './kommoClient.js'
import { getLeadIdByTelefone } from './dadosClienteStore.js'
import { getMessageBufferRedis } from './evolution/messageBuffer.js'

const MIRROR_NOTE_TTL_SEC = 604800 // 7 dias
const MIRROR_MSG_TTL_SEC = 86400 // 24h dedupe por wamid/evolution id

/** @type {Map<number, Set<number>>} */
const mirroredNoteIdsMem = new Map()

function mirrorEnabled(env) {
  const v = String(env.KOMMO_INBOUND_MIRROR_ENABLED ?? 'true').trim().toLowerCase()
  return !(v === 'false' || v === '0' || v === 'no')
}

function digitsOnly(input) {
  return String(input || '').split('@')[0].replace(/[^0-9]/g, '')
}

function formatE164BR(digits) {
  const d = digitsOnly(digits)
  if (!d) return ''
  if (d.startsWith('55') && d.length >= 12) return `+${d}`
  if (d.length >= 10) return `+55${d}`
  return `+${d}`
}

function redisMirrorNoteKey(keyPrefix, leadId) {
  return `${keyPrefix || ''}kommo:mirror:note:${leadId}`
}

function redisMirrorMsgKey(keyPrefix, messageId) {
  return `${keyPrefix || ''}kommo:mirror:msg:${messageId}`
}

export function registerMirroredNoteId(leadId, noteId) {
  const lid = Number(leadId)
  const nid = Number(noteId)
  if (!Number.isFinite(lid) || lid <= 0 || !Number.isFinite(nid) || nid <= 0) return
  if (!mirroredNoteIdsMem.has(lid)) mirroredNoteIdsMem.set(lid, new Set())
  mirroredNoteIdsMem.get(lid).add(nid)
}

export function isMirroredNoteIdSync(leadId, noteId) {
  const lid = Number(leadId)
  const nid = Number(noteId)
  const set = mirroredNoteIdsMem.get(lid)
  return Boolean(set?.has(nid))
}

export async function isMirroredInboundNoteId(env, leadId, noteId) {
  if (isMirroredNoteIdSync(leadId, noteId)) return true
  try {
    const { client, keyPrefix } = await getMessageBufferRedis(env)
    if (!client) return false
    const member = await client.sismember(redisMirrorNoteKey(keyPrefix, leadId), String(noteId))
    return member === 1
  } catch {
    return false
  }
}

async function markMirroredNoteId(env, leadId, noteId) {
  registerMirroredNoteId(leadId, noteId)
  try {
    const { client, keyPrefix } = await getMessageBufferRedis(env)
    if (!client) return
    const key = redisMirrorNoteKey(keyPrefix, leadId)
    await client.sadd(key, String(noteId))
    await client.expire(key, MIRROR_NOTE_TTL_SEC)
  } catch (e) {
    console.warn('[kommo-mirror] redis note mark falhou:', e.message)
  }
}

async function wasMirroredMessage(env, messageId) {
  const id = String(messageId || '').trim()
  if (!id) return false
  try {
    const { client, keyPrefix } = await getMessageBufferRedis(env)
    if (!client) return false
    const hit = await client.get(redisMirrorMsgKey(keyPrefix, id))
    return Boolean(hit)
  } catch {
    return false
  }
}

async function markMirroredMessage(env, messageId) {
  const id = String(messageId || '').trim()
  if (!id) return
  try {
    const { client, keyPrefix } = await getMessageBufferRedis(env)
    if (!client) return
    const key = redisMirrorMsgKey(keyPrefix, id)
    await client.set(key, '1', 'EX', MIRROR_MSG_TTL_SEC)
  } catch (e) {
    console.warn('[kommo-mirror] redis msg mark falhou:', e.message)
  }
}

async function resolveLeadId(env, telefone) {
  try {
    const lookup = await findLeadByPhone(env, telefone)
    if (lookup.ok && lookup.lead?.id) return Number(lookup.lead.id)
  } catch (e) {
    console.warn('[kommo-mirror] findLeadByPhone:', e.message)
  }
  try {
    const id = await getLeadIdByTelefone(env, telefone)
    if (id != null && id !== '') return Number(id)
  } catch {
    /* ignore */
  }
  return null
}

/**
 * @param {Record<string,string>} env
 * @param {{ sessionId: string, text: string, pushName?: string, messageId?: string }} p
 */
export async function mirrorEvolutionInboundToKommo(env, p) {
  if (!mirrorEnabled(env)) return { skipped: 'disabled' }

  const telefone = digitsOnly(p?.sessionId)
  const text = String(p?.text || '').trim()
  if (!telefone || !text) return { skipped: 'empty' }

  if (p?.messageId && (await wasMirroredMessage(env, p.messageId))) {
    return { skipped: 'duplicate_message_id' }
  }

  const leadId = await resolveLeadId(env, telefone)
  if (!leadId) {
    console.log(`[kommo-mirror] lead não encontrado p/ ${telefone.slice(0, 6)}…`)
    return { skipped: 'no_lead' }
  }

  const phone = formatE164BR(telefone)
  const note = await createLeadSmsInNote(env, leadId, text, phone)
  if (!note.ok) {
    console.warn(
      `[kommo-mirror] falha lead=${leadId} status=${note.status || 'n/a'} err=${note.error || note.code || '?'}`,
    )
    return { ok: false, ...note }
  }

  if (note.noteId) await markMirroredNoteId(env, leadId, note.noteId)
  if (p?.messageId) await markMirroredMessage(env, p.messageId)

  console.log(
    `[kommo-mirror] sms_in lead=${leadId} note=${note.noteId || '?'} tel=${telefone.slice(0, 6)}… len=${text.length}`,
  )
  return { ok: true, leadId, noteId: note.noteId }
}
