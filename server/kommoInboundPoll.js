/**
 * Hidrata o message buffer a partir do Kommo (sem depender do webhook Evolution).
 *
 * Modos (KOMMO_INBOUND_POLL_MODE):
 *   - notes (default): GET /api/v4/leads/{id}/notes — só Bearer KOMMO_*.
 *   - amojo: histórico Amojo — precisa KOMMO_CHANNEL_SECRET + KOMMO_CHANNEL_SCOPE_ID + chat_id
 *     (via KOMMO_LEAD_CHAT_MAP JSON ou descoberta de /api/v4/talks).
 *
 * Warmup: no primeiro tick por lead, grava o cursor no último item existente e não empurra
 * mensagens antigas (evita reprocessar histórico inteiro após deploy).
 */

import { pushMessage } from './evolution/messageBuffer.js'
import { listLeadNotes, tryListTalksForLead, getTalkById } from './kommoClient.js'
import { fetchAmojoChatHistory } from './kommoAmojoHistory.js'
import { digitsToWhatsAppLocalPart } from './phoneWhatsApp.js'

/** @type {Map<number, { warmed: boolean, lastNoteId: number }>} */
const noteState = new Map()
/** @type {Map<number, { warmed: boolean, lastMsec: number }>} */
const amojoState = new Map()

export function isKommoInboundPollEnabled(env) {
  const f = String(env.KOMMO_INBOUND_POLL_ENABLED || '').trim().toLowerCase()
  return f === 'true' || f === '1' || f === 'yes'
}

function pollEnabled(env) {
  return isKommoInboundPollEnabled(env)
}

function pollMode(env) {
  return String(env.KOMMO_INBOUND_POLL_MODE || 'notes').trim().toLowerCase()
}

function normalizeDigits(phone) {
  const d = String(phone || '').replace(/[^0-9]/g, '')
  return digitsToWhatsAppLocalPart(d) || ''
}

/** Compara dígitos do telefone com tolerância a 55 / DDD. */
function phoneDigitsMatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (a.endsWith(b) || b.endsWith(a)) return true
  return false
}

function parseNoteTypes(env) {
  const raw =
    env.KOMMO_INBOUND_POLL_NOTE_TYPES ||
    'sms_in,extended_service_message,service_message'
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function extractNoteText(note, env) {
  const t = String(note?.note_type || '').toLowerCase()
  const p = note?.params || {}
  if (t === 'sms_in') return String(p.text || '').trim()
  if (t === 'extended_service_message' || t === 'service_message') {
    return String(p.text || '').trim()
  }
  const incCommon = String(env.KOMMO_INBOUND_POLL_INCLUDE_COMMON || '')
    .trim()
    .toLowerCase()
  if (t === 'common' && (incCommon === 'true' || incCommon === '1' || incCommon === 'yes')) {
    return String(p.text || '').trim()
  }
  return ''
}

function isOutboundNoteType(noteType) {
  const t = String(noteType || '').toLowerCase()
  return t === 'sms_out' || t === 'call_out'
}

async function resolveChatId(env, leadId) {
  const mapRaw = String(env.KOMMO_LEAD_CHAT_MAP || '').trim()
  if (mapRaw) {
    try {
      const m = JSON.parse(mapRaw)
      const v = m[String(leadId)] ?? m[Number(leadId)]
      if (v) return String(v)
    } catch {
      /* ignore */
    }
  }
  const listed = await tryListTalksForLead(env, leadId)
  const talks = listed.talks || []
  if (!talks.length) return null
  const t =
    talks.find((x) => String(x?.entity_type || '').toLowerCase() === 'lead') || talks[0]
  if (t?.chat_id) return String(t.chat_id)
  const tid = t?.talk_id ?? t?.id
  if (tid) {
    const d = await getTalkById(env, tid)
    if (d.ok && d.talk?.chat_id) return String(d.talk.chat_id)
  }
  return null
}

function amojoConfigured(env) {
  return Boolean(
    String(env.KOMMO_CHANNEL_SECRET || '').trim() &&
      String(env.KOMMO_CHANNEL_SCOPE_ID || '').trim(),
  )
}

function isAmojoInboundRow(row, contactDigits) {
  const sp = row?.sender?.phone
  if (!sp || !contactDigits) return false
  const d = normalizeDigits(sp)
  return phoneDigitsMatch(d, contactDigits)
}

async function pollNotes(env, leadId, sessionId, contactDigits) {
  const lid = Number(leadId)
  let st = noteState.get(lid) || { warmed: false, lastNoteId: 0 }
  const types = parseNoteTypes(env)
  const list = await listLeadNotes(env, lid, { limit: 80, order: 'desc' })
  if (!list.ok) {
    console.warn(`[kommo-poll][notes] lead=${lid}:`, list.error || list.status)
    return 0
  }
  const notes = list.notes || []
  if (!st.warmed) {
    const maxId = notes.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0)
    noteState.set(lid, { warmed: true, lastNoteId: maxId })
    console.log(`[kommo-poll][notes] warmup lead=${lid} lastNoteId=${maxId}`)
    return 0
  }
  const fresh = notes.filter((n) => Number(n.id) > st.lastNoteId)
  const asc = [...fresh].sort((a, b) => Number(a.id) - Number(b.id))
  let pushed = 0
  let maxApplied = st.lastNoteId
  for (const n of asc) {
    const nid = Number(n.id)
    if (isOutboundNoteType(n.note_type)) {
      maxApplied = Math.max(maxApplied, nid)
      continue
    }
    if (!types.includes(String(n.note_type || '').toLowerCase())) {
      maxApplied = Math.max(maxApplied, nid)
      continue
    }
    const text = extractNoteText(n, env)
    if (!text) {
      maxApplied = Math.max(maxApplied, nid)
      continue
    }
    if (String(n.note_type || '').toLowerCase() === 'sms_in' && contactDigits) {
      const np = normalizeDigits(n.params?.phone || '')
      if (np && !phoneDigitsMatch(np, contactDigits)) continue
    }
    await pushMessage(env, sessionId, text)
    maxApplied = Math.max(maxApplied, nid)
    pushed += 1
  }
  noteState.set(lid, { warmed: true, lastNoteId: Math.max(st.lastNoteId, maxApplied) })
  if (pushed > 0) {
    console.log(`[kommo-poll][notes] buffer +${pushed} lead=${lid} session=${sessionId}`)
  }
  return pushed
}

async function pollAmojo(env, leadId, sessionId, contactDigits) {
  if (!amojoConfigured(env)) return 0
  const lid = Number(leadId)
  let st = amojoState.get(lid) || { warmed: false, lastMsec: 0 }
  const chatId = await resolveChatId(env, lid)
  if (!chatId) {
    if (!st.warmed) {
      console.warn(
        `[kommo-poll][amojo] sem chat_id p/ lead=${lid} — KOMMO_LEAD_CHAT_MAP ou talks`,
      )
    }
    return 0
  }
  const scopeId = String(env.KOMMO_CHANNEL_SCOPE_ID || '').trim()
  const hist = await fetchAmojoChatHistory(env, {
    scopeId,
    conversationId: chatId,
    limit: 40,
    offset: 0,
  })
  if (!hist.ok) {
    console.warn(`[kommo-poll][amojo] lead=${lid}:`, hist.error || hist.status)
    return 0
  }
  const rows = hist.messages || []
  const sorted = [...rows].sort((a, b) => (a.msec_timestamp || 0) - (b.msec_timestamp || 0))
  if (!st.warmed) {
    const maxM = sorted.reduce((m, x) => Math.max(m, x.msec_timestamp || 0), 0)
    amojoState.set(lid, { warmed: true, lastMsec: maxM })
    console.log(`[kommo-poll][amojo] warmup lead=${lid} lastMsec=${maxM}`)
    return 0
  }
  const nincoming = sorted.filter((x) => (x.msec_timestamp || 0) > st.lastMsec)
  let pushed = 0
  let lastM = st.lastMsec
  for (const row of nincoming) {
    if (!isAmojoInboundRow(row, contactDigits)) {
      lastM = Math.max(lastM, row.msec_timestamp || 0)
      continue
    }
    const mtype = String(row?.message?.type || '').toLowerCase()
    const text = String(row?.message?.text || '').trim()
    if (!text) {
      lastM = Math.max(lastM, row.msec_timestamp || 0)
      continue
    }
    if (mtype === 'picture' || mtype === 'sticker' || mtype === 'audio' || mtype === 'voice') {
      lastM = Math.max(lastM, row.msec_timestamp || 0)
      continue
    }
    await pushMessage(env, sessionId, text)
    lastM = Math.max(lastM, row.msec_timestamp || 0)
    pushed += 1
  }
  amojoState.set(lid, { warmed: true, lastMsec: lastM })
  if (pushed > 0) {
    console.log(`[kommo-poll][amojo] buffer +${pushed} lead=${lid} session=${sessionId}`)
  }
  return pushed
}

/**
 * @param {Record<string,string>} env
 * @param {{ leadId: number, sessionId: string, phone: string }} p
 * @returns { Promise<{ pushed: number }> }
 */
export async function syncKommoInboundToBuffer(env, { leadId, sessionId, phone }) {
  if (!pollEnabled(env)) return { pushed: 0 }
  const mode = pollMode(env)
  const contactDigits = normalizeDigits(phone)
  let pushed = 0
  if (mode === 'amojo') {
    if (!amojoConfigured(env)) {
      console.warn('[kommo-poll] mode=amojo mas faltam KOMMO_CHANNEL_SECRET / KOMMO_CHANNEL_SCOPE_ID')
      return { pushed: 0 }
    }
    pushed += await pollAmojo(env, leadId, sessionId, contactDigits)
    return { pushed }
  }
  if (mode === 'both') {
    pushed += await pollNotes(env, leadId, sessionId, contactDigits)
    pushed += await pollAmojo(env, leadId, sessionId, contactDigits)
    return { pushed }
  }
  pushed += await pollNotes(env, leadId, sessionId, contactDigits)
  return { pushed }
}
