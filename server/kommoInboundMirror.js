/**
 * Espelha mensagens inbound do WhatsApp (Evolution webhook) no timeline Kommo.
 * Sem isso, o agente processa o texto mas o CRM só mostra respostas do bot (notas common).
 */

import { findLeadByPhone, createLeadInboundSmsNote } from './kommoClient.js'
import { advanceKommoInboundPollNoteCursor } from './kommoInboundPoll.js'
import { getLeadIdByTelefone } from './dadosClienteStore.js'

/** @type {Map<string, number>} messageId → expireAt ms */
const mirroredMessageIds = new Map()

function pruneMirrorDedupe(now = Date.now()) {
  for (const [k, ex] of mirroredMessageIds) {
    if (ex <= now) mirroredMessageIds.delete(k)
  }
}

function mirrorDedupeTtlMs(env) {
  const raw = String(env.KOMMO_INBOUND_MIRROR_DEDUPE_SEC ?? '86400').trim()
  const sec = Number(raw)
  if (Number.isFinite(sec) && sec > 0) return Math.floor(sec * 1000)
  return 86400000
}

export function isKommoInboundMirrorEnabled(env) {
  const raw = String(env.KOMMO_INBOUND_MIRROR_ENABLED ?? 'true').trim().toLowerCase()
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false
  const base = String(env.KOMMO_BASE_URL || '').trim()
  const token = String(env.KOMMO_ACCESS_TOKEN || '').trim()
  return Boolean(base && token)
}

/** Texto legível no CRM (sem marcadores internos do pipeline de mídia). */
export function kommoMirrorDisplayText(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const audio = raw.match(/^\[ÁUDIO TRANSCRITO\]:\s*(.+)$/is)
  if (audio?.[1]) return String(audio[1]).trim()
  if (/^\[ÁUDIO RECEBIDO\b/i.test(raw)) return '🎤 Áudio enviado pelo candidato'
  if (/^\[IMAGEM RECEBIDA\b/i.test(raw)) {
    const cap = raw.match(/Legenda (?:do lead|enviada pelo lead)[^:]*:\s*"([^"]+)"/i)
    if (cap?.[1]) return `📷 Imagem: ${cap[1]}`
    return '📷 Imagem enviada pelo candidato'
  }
  if (/^\[FORMULARIO SUMAR\]:/i.test(raw)) {
    const jsonPart = raw.replace(/^\[FORMULARIO SUMAR\]:\s*/i, '').trim()
    if (jsonPart.startsWith('{')) {
      try {
        const obj = JSON.parse(jsonPart)
        const keys = Object.keys(obj || {})
        if (keys.length) return `📋 Formulário preenchido (${keys.length} campos)`
      } catch { /* ignore */ }
    }
    return '📋 Formulário preenchido'
  }
  return raw
}

async function resolveLeadId(env, { telefone, leadId }) {
  const hinted = Number(leadId)
  if (Number.isFinite(hinted) && hinted > 0) return hinted
  try {
    const fromDb = await getLeadIdByTelefone(env, telefone)
    if (fromDb != null && Number(fromDb) > 0) return Number(fromDb)
  } catch { /* ignore */ }
  const lookup = await findLeadByPhone(env, telefone)
  if (lookup.ok && lookup.lead?.id) return Number(lookup.lead.id)
  return null
}

/**
 * Cria nota sms_in no lead. Fire-and-forget: erros só vão pro log.
 *
 * @param {Record<string,string>} env
 * @param {{ telefone: string, text: string, messageId?: string|null, leadId?: number|null }} p
 */
export async function mirrorInboundToKommo(env, { telefone, text, messageId, leadId } = {}) {
  if (!isKommoInboundMirrorEnabled(env)) return { ok: false, skipped: true, reason: 'disabled' }
  const display = kommoMirrorDisplayText(text)
  if (!display) return { ok: false, skipped: true, reason: 'empty_text' }

  if (messageId) {
    pruneMirrorDedupe()
    const key = String(messageId)
    if (mirroredMessageIds.has(key)) {
      return { ok: true, skipped: true, reason: 'duplicate_message_id' }
    }
  }

  const lid = await resolveLeadId(env, { telefone, leadId })
  if (!lid) {
    console.warn(
      `[kommo-mirror] lead não encontrado telefone=${String(telefone || '').slice(0, 16)} msg="${display.slice(0, 60)}"`,
    )
    return { ok: false, skipped: true, reason: 'lead_not_found' }
  }

  const note = await createLeadInboundSmsNote(env, lid, { text: display, phone: telefone })
  if (!note.ok) {
    console.warn(
      `[kommo-mirror] falha lead=${lid} status=${note.status || 'n/a'} err=${note.error || note.code || 'unknown'}`,
    )
    return { ok: false, error: note.error || note.code, leadId: lid }
  }

  if (note.noteId) advanceKommoInboundPollNoteCursor(lid, note.noteId)
  if (messageId) mirroredMessageIds.set(String(messageId), Date.now() + mirrorDedupeTtlMs(env))

  console.log(
    `[kommo-mirror] ok lead=${lid} noteId=${note.noteId || 'n/a'} chars=${display.length} preview="${display.slice(0, 80)}"`,
  )
  return { ok: true, leadId: lid, noteId: note.noteId }
}
