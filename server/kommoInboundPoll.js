/**
 * Hidrata o message buffer a partir do Kommo (sem depender do webhook Evolution).
 *
 * Modos (KOMMO_INBOUND_POLL_MODE):
 *   - notes (default): GET /api/v4/leads/{id}/notes — só Bearer KOMMO_*.
 *     (O valor `note` no .env é aceito como alias de `notes`.)
 *     Por padrão também consulta eventos v4 `incoming_chat_message` após as notas
 *     (KOMMO_INBOUND_POLL_NOTES_ALSO_EVENTS, default true): no Kommo a linha do tempo
 *     mistura “notas” (common, integração, IA) com mensagens de chat; o texto que o
 *     lead manda no WhatsApp costuma existir no feed de eventos mesmo quando a nota
 *     common ainda não reflete ou reflete só o eco da integração.
 *   - events: GET /api/v4/events?filter[type]=incoming_chat_message — só Bearer KOMMO_*
 *     (mais robusto, pega mensagem mesmo quando não vira nota).
 *   - amojo: histórico Amojo — precisa KOMMO_CHANNEL_SECRET + KOMMO_CHANNEL_SCOPE_ID + chat_id
 *     (via KOMMO_LEAD_CHAT_MAP JSON ou descoberta de /api/v4/talks).
 *   - dispatcher: lê do banco-kommo-dispatcher (FastAPI) que já mantém cache
 *     atualizado das mensagens. RECOMENDADO quando esse serviço existe na
 *     mesma rede do EasyPanel. Usa GET /api/kommo/messages/by-lead/{id}.
 *     Se o serviço não existir (ENOTFOUND), o boot pode forçar `both` — ver
 *     maybeFallbackPollModeWhenDispatcherDown e KOMMO_INBOUND_POLL_DISPATCHER_FALLBACK.
 *   - both: só notas por padrão (Kommo Bearer, sem Amojo). Eventos da v4 só se
 *     KOMMO_INBOUND_POLL_ALSO_POLL_EVENTS=true (útil p/ integrações sem nota).
 *   - all: notes + events + amojo (Amojo só roda se as envs estiverem setadas).
 *
 * Warmup: no primeiro tick por lead, grava o cursor no último id de nota existente e não
 * empurra o histórico inteiro. Se o id mais alto for de nota do agente/sistema acima da
 * última mensagem do cliente, o cursor “passava por cima” do cliente (fresh=0 para sempre);
 * nesse caso, com KOMMO_INBOUND_POLL_NOTES_TAIL_SEED_ON_WARMUP ligado (default), empurra
 * uma vez a última mensagem inbound elegível antes dessa cauda (dedupe via Redis quando
 * REDIS_URL/REDIS_HOST existir).
 */

import Redis from 'ioredis'
import { pushMessage } from './evolution/messageBuffer.js'
import {
  listLeadNotes,
  listLeadEvents,
  tryListTalksForLead,
  getTalkById,
} from './kommoClient.js'
import { fetchAmojoChatHistory } from './kommoAmojoHistory.js'
import {
  getMessagesByLead as dispatcherGetMessagesByLead,
  checkDispatcherHealth,
} from './kommoDispatcherClient.js'
import { digitsToWhatsAppLocalPart } from './phoneWhatsApp.js'
import { transcribeAudioBase64, analyzeImageBase64 } from './evolution/openaiMedia.js'
import { downloadUrlAsBase64 } from './mediaDownloader.js'
import {
  recordNotesTick,
  recordAmojoTick,
  recordEventsTick,
  recordDispatcherTick,
} from './kommoInboundDiagnostics.js'

/** @type {Map<number, { warmed: boolean, lastNoteId: number }>} */
const noteState = new Map()
/** @type {Map<number, { warmed: boolean, lastMsec: number }>} */
const amojoState = new Map()
/** @type {Map<number, { warmed: boolean, lastSeenAt: number, seenIds: Set<string> }>} */
const eventState = new Map()
/** @type {Map<number, { warmed: boolean, lastMsgId: number, seenIds: Set<number> }>} */
const dispatcherState = new Map()

export function isKommoInboundPollEnabled(env) {
  const f = String(env.KOMMO_INBOUND_POLL_ENABLED || '').trim().toLowerCase()
  return f === 'true' || f === '1' || f === 'yes'
}

function pollEnabled(env) {
  return isKommoInboundPollEnabled(env)
}

/** Modo efetivo do poll (use no scheduler, boot e checks). */
export function normalizeKommoInboundPollMode(raw) {
  let m = String(raw ?? 'notes')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
  if (m === 'note') m = 'notes'
  return m
}

function pollMode(env) {
  return normalizeKommoInboundPollMode(env.KOMMO_INBOUND_POLL_MODE)
}

/** Em mode=both, rodar poll de eventos v4 (opcional; default false = só notas Kommo). */
function alsoPollEventsInBoth(env) {
  const v = String(env.KOMMO_INBOUND_POLL_ALSO_POLL_EVENTS ?? '')
    .trim()
    .toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/**
 * Em mode=notes, após poll de notas, rodar também eventos v4 (incoming_chat_message).
 * Default true: captura mensagens de chat do WhatsApp no Kommo sem Amojo; desligue com
 * KOMMO_INBOUND_POLL_NOTES_ALSO_EVENTS=false se quiser estritamente só GET .../notes.
 */
function alsoPollEventsWithNotes(env) {
  const v = String(env.KOMMO_INBOUND_POLL_NOTES_ALSO_EVENTS ?? 'true').trim().toLowerCase()
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false
  return true
}

let loggedDispatcherFallback = false

/**
 * Se o poll estiver em modo `dispatcher` ou `all` mas o serviço HTTP
 * do dispatcher não existir (ENOTFOUND) ou estiver parado
 * (ECONNREFUSED), força `KOMMO_INBOUND_POLL_MODE=notes` em runtime
 * (apenas GET /api/v4/leads/{id}/notes — Bearer Kommo, sem dispatcher/Amojo).
 *
 * Desligue com KOMMO_INBOUND_POLL_DISPATCHER_FALLBACK=false se quiser
 * manter falha explícita até o dispatcher existir.
 *
 * @param {Record<string,string>} env  process.env (mutável)
 * @returns {Promise<{ changed: boolean, from?: string, to?: string, reason?: string }>}
 */
export async function maybeFallbackPollModeWhenDispatcherDown(env) {
  if (!pollEnabled(env)) return { changed: false, reason: 'poll_disabled' }
  const fb = String(env.KOMMO_INBOUND_POLL_DISPATCHER_FALLBACK ?? 'true').trim().toLowerCase()
  if (fb === 'false' || fb === '0' || fb === 'no') {
    return { changed: false, reason: 'fallback_disabled_by_env' }
  }
  const mode = pollMode(env)
  if (mode !== 'dispatcher' && mode !== 'all') {
    return { changed: false, reason: 'not_dispatcher_mode', mode }
  }
  const h = await checkDispatcherHealth(env, { timeoutMs: 5000 })
  if (h.ok) return { changed: false, reason: 'dispatcher_reachable', mode }
  const cause = h.cause || ''
  if (cause !== 'ENOTFOUND' && cause !== 'ECONNREFUSED') {
    console.warn(
      `[kommo-poll] dispatcher health falhou (${cause || h.error}) — mantendo modo=${mode}. ` +
        `Se persistir, defina KOMMO_INBOUND_POLL_MODE=notes ou corrija KOMMO_DISPATCHER_URL.`,
    )
    return { changed: false, reason: 'transient_or_other', mode }
  }
  const was = mode
  env.KOMMO_INBOUND_POLL_MODE = 'notes'
  process.env.KOMMO_INBOUND_POLL_MODE = 'notes'
  if (!loggedDispatcherFallback) {
    loggedDispatcherFallback = true
    console.error(
      `[kommo-poll] FALLBACK AUTOMATICO: modo era "${was}" mas o dispatcher em ${h.upstream} ` +
        `esta inacessivel (${cause}). Forcando KOMMO_INBOUND_POLL_MODE=notes (somente notas v4 / Bearer). ` +
        `Eventos WABA sem texto exigem Amojo ou notas common — evitamos mode=both aqui. ` +
        `Para desligar este fallback: KOMMO_INBOUND_POLL_DISPATCHER_FALLBACK=false`,
    )
  }
  return { changed: true, from: was, to: 'notes', reason: 'dispatcher_unreachable' }
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
    'sms_in,extended_service_message,service_message,common'
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function isCommonInboundEnabled(env) {
  const types = parseNoteTypes(env)
  if (!types.includes('common')) return false
  const inc = String(env.KOMMO_INBOUND_POLL_INCLUDE_COMMON || '').trim().toLowerCase()
  if (inc === 'false' || inc === '0' || inc === 'no') return false
  if (inc === 'true' || inc === '1' || inc === 'yes') return true
  return inc === ''
}

/**
 * Texto inbound em `params` de notas Kommo — WhatsApp Cloud / canais variam
 * (`text`, `body`, objeto `message`, etc.).
 */
function extractParamsInboundText(p) {
  if (p == null) return ''
  if (typeof p === 'string') return p.trim()
  if (typeof p !== 'object') return String(p).trim()
  for (const k of ['text', 'body', 'content', 'message_text', 'msg', 'caption']) {
    const v = p[k]
    if (v != null && String(v).trim()) return String(v).trim()
  }
  const msg = p.message
  if (msg && typeof msg === 'object') {
    for (const k of ['text', 'body', 'content']) {
      const v = msg[k]
      if (v != null && String(v).trim()) return String(v).trim()
    }
  }
  if (typeof p.message === 'string' && p.message.trim()) return p.message.trim()
  return ''
}

function extractNoteText(note, env) {
  const t = String(note?.note_type || '').toLowerCase()
  const p = note?.params || {}
  if (t === 'sms_in') {
    return extractParamsInboundText(p) || String(p.text || '').trim()
  }
  if (t === 'extended_service_message' || t === 'service_message') {
    return extractParamsInboundText(p) || String(p.text || '').trim()
  }
  if (t === 'common' && isCommonInboundEnabled(env)) {
    return extractParamsInboundText(p) || String(p.text || '').trim()
  }
  return ''
}

function isOutboundNoteType(noteType) {
  const t = String(noteType || '').toLowerCase()
  return t === 'sms_out' || t === 'call_out'
}

/**
 * Notas que o próprio agente cria têm sufixo ` - EX-YYMMDD-HHMM-NNN` (ver
 * generateExecutionId + sendMessageWithNote). Não tratar como inbound, senão
 * a resposta da IA volta como pergunta no próximo tick.
 */
const AGENT_OUTBOUND_SUFFIX = /\s-\sEX-\d{6}-\d{4}-\d{3}\s*$/

function isAgentOutboundEcho(text) {
  return AGENT_OUTBOUND_SUFFIX.test(String(text || ''))
}

const SUFFIX_PATTERNS = [
  /-\s+EX-\d{6}-\d{4}-\d{3}\s*$/,
  /-\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
]

function stripExecutionSuffix(text) {
  let s = String(text || '')
  for (const re of SUFFIX_PATTERNS) {
    s = s.replace(re, '')
  }
  return s.trim()
}

/**
 * Classifica uma nota do Kommo para o mesmo critério do loop de poll (inbound vs skip).
 * @returns {{ kind: 'push', text: string, nid: number } | { kind: 'skip', reason: string, advance: boolean, nid: number }}
 */
function classifyInboundNote(n, env, contactDigits, types) {
  const nid = Number(n.id) || 0
  if (isOutboundNoteType(n.note_type)) {
    return { kind: 'skip', reason: 'outbound_type', advance: true, nid }
  }
  if (!types.includes(String(n.note_type || '').toLowerCase())) {
    return { kind: 'skip', reason: 'type', advance: true, nid }
  }
  const rawText = extractNoteText(n, env)
  if (!rawText) {
    return { kind: 'skip', reason: 'empty', advance: true, nid }
  }
  if (String(n.note_type || '').toLowerCase() === 'common' && isAgentOutboundEcho(rawText)) {
    return { kind: 'skip', reason: 'echo', advance: true, nid }
  }
  const text = stripExecutionSuffix(rawText)
  if (!text) {
    return { kind: 'skip', reason: 'strip_empty', advance: true, nid }
  }
  if (String(n.note_type || '').toLowerCase() === 'sms_in' && contactDigits) {
    const np = normalizeDigits(n.params?.phone || '')
    if (np && !phoneDigitsMatch(np, contactDigits)) {
      return { kind: 'skip', reason: 'other_phone', advance: false, nid }
    }
  }
  return { kind: 'push', text, nid }
}

function findTailBlockedInboundForWarmup(notes, env, contactDigits, types) {
  const maxAll = notes.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0)
  if (!notes.length || !maxAll) return null
  const byDesc = [...notes].sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
  for (const n of byDesc) {
    const c = classifyInboundNote(n, env, contactDigits, types)
    if (c.kind !== 'push') continue
    const nid = c.nid
    const higher = notes.filter((x) => (Number(x.id) || 0) > nid)
    const allHigherNonInbound = higher.every(
      (x) => classifyInboundNote(x, env, contactDigits, types).kind !== 'push',
    )
    if (allHigherNonInbound && maxAll > nid) {
      return { text: c.text, nid, maxAll }
    }
  }
  return null
}

function isNotesTailSeedOn(env) {
  const v = String(env.KOMMO_INBOUND_POLL_NOTES_TAIL_SEED_ON_WARMUP ?? 'true')
    .trim()
    .toLowerCase()
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  return true
}

let _tailSeedRedis = null
const _tailSeedMemOk = new Set()

function buildTailSeedRedisClient(env) {
  const commonOpts = {
    lazyConnect: true,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
    connectTimeout: 3000,
    enableOfflineQueue: false,
  }
  if (env.REDIS_URL) return new Redis(env.REDIS_URL, commonOpts)
  if (env.REDIS_HOST) {
    return new Redis({
      host: env.REDIS_HOST || '127.0.0.1',
      port: Number(env.REDIS_PORT || 6379),
      password: env.REDIS_PASSWORD || undefined,
      db: Number(env.REDIS_DB || 0),
      tls: String(env.REDIS_TLS || '').toLowerCase() === 'true' ? {} : undefined,
      ...commonOpts,
    })
  }
  return null
}

function getTailSeedRedis(env) {
  if (!env.REDIS_URL && !env.REDIS_HOST) return null
  if (!_tailSeedRedis) {
    _tailSeedRedis = buildTailSeedRedisClient(env)
    _tailSeedRedis.on('error', (err) => {
      console.warn('[kommo-poll][notes] tail-seed Redis error:', err.message)
    })
  }
  return _tailSeedRedis
}

/**
 * Garante no máximo um tail-seed por (lead, noteId) entre restarts (Redis SET NX) ou,
 * sem Redis, só dentro do mesmo processo.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function tryTailSeedOnce(env, leadId, noteId) {
  const memKey = `${leadId}:${noteId}`
  const redisKey = `kommo:poll:tailseed:v1:${leadId}:${noteId}`
  const ttlRaw = Number(env.KOMMO_INBOUND_POLL_TAIL_SEED_DEDUPE_SEC)
  const ttlSec =
    Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(Math.floor(ttlRaw), 2592000) : 604800
  const client = getTailSeedRedis(env)
  if (client) {
    try {
      if (client.status === 'wait') {
        await Promise.race([
          client.connect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 3500)),
        ])
      }
      const r = await client.set(redisKey, '1', 'EX', ttlSec, 'NX')
      if (r !== 'OK') return { ok: false, reason: 'dedup' }
      return { ok: true }
    } catch (e) {
      console.warn(`[kommo-poll][notes] tail-seed Redis indisponível (${e.message}) — dedupe só em memória neste processo`)
    }
  }
  if (_tailSeedMemOk.has(memKey)) return { ok: false, reason: 'dedup' }
  _tailSeedMemOk.add(memKey)
  return { ok: true }
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

function countTypes(notes) {
  const out = {}
  for (const n of notes) {
    const t = String(n?.note_type || 'unknown').toLowerCase()
    out[t] = (out[t] || 0) + 1
  }
  return out
}

async function pollNotes(env, leadId, sessionId, contactDigits) {
  const lid = Number(leadId)
  let st = noteState.get(lid) || { warmed: false, lastNoteId: 0 }
  const types = parseNoteTypes(env)
  const list = await listLeadNotes(env, lid, { limit: 120, order: 'desc' })
  if (!list.ok) {
    console.warn(`[kommo-poll][notes] lead=${lid}:`, list.error || list.status)
    recordNotesTick({
      leadId: lid,
      sessionId,
      warmedUp: st.warmed,
      notesTotal: 0,
      typeCounts: {},
      freshCount: 0,
      pushedCount: 0,
      filteredByType: 0,
      filteredEmpty: 0,
      filteredOutbound: 0,
      filteredOtherPhone: 0,
      lastNoteId: st.lastNoteId,
      pollMode: 'notes',
      error: String(list.error || list.status || 'unknown'),
    })
    return 0
  }
  const notes = list.notes || []
  const typeCounts = countTypes(notes)
  if (!st.warmed) {
    const maxId = notes.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0)
    const tail = findTailBlockedInboundForWarmup(notes, env, contactDigits, types)
    if (tail && isNotesTailSeedOn(env)) {
      const gate = await tryTailSeedOnce(env, lid, tail.nid)
      if (gate.ok) {
        await pushMessage(env, sessionId, tail.text, { skipDedupe: true })
        console.log(
          `[kommo-poll][notes] warmup tail-seed lead=${lid} noteId=${tail.nid} maxNoteId=${tail.maxAll} ` +
            `(última nota no timeline tinha id maior que a última msg inbound — evita buffer eternamente vazio)`,
        )
      } else if (gate.reason === 'dedup') {
        console.log(
          `[kommo-poll][notes] warmup tail-seed omitido (já deduplicado) lead=${lid} noteId=${tail.nid}`,
        )
      }
    }
    noteState.set(lid, { warmed: true, lastNoteId: maxId })
    console.log(
      `[kommo-poll][notes] warmup lead=${lid} lastNoteId=${maxId} notas=${notes.length} tipos=${JSON.stringify(typeCounts)}`,
    )
    recordNotesTick({
      leadId: lid,
      sessionId,
      warmedUp: false,
      notesTotal: notes.length,
      typeCounts,
      freshCount: 0,
      pushedCount: 0,
      filteredByType: 0,
      filteredEmpty: 0,
      filteredOutbound: 0,
      filteredOtherPhone: 0,
      lastNoteId: maxId,
      pollMode: 'notes',
    })
    return 0
  }
  const fresh = notes.filter((n) => Number(n.id) > st.lastNoteId)
  const asc = [...fresh].sort((a, b) => Number(a.id) - Number(b.id))
  let pushed = 0
  let maxApplied = st.lastNoteId
  let filteredByType = 0
  let filteredEmpty = 0
  let filteredOutbound = 0
  let filteredOtherPhone = 0
  for (const n of asc) {
    const nid = Number(n.id)
    const c = classifyInboundNote(n, env, contactDigits, types)
    if (c.kind === 'push') {
      await pushMessage(env, sessionId, c.text, { skipDedupe: true })
      maxApplied = Math.max(maxApplied, c.nid)
      pushed += 1
      continue
    }
    if (c.reason === 'outbound_type' || c.reason === 'echo') {
      filteredOutbound += 1
    } else if (c.reason === 'type') {
      filteredByType += 1
    } else if (c.reason === 'empty' || c.reason === 'strip_empty') {
      filteredEmpty += 1
    } else if (c.reason === 'other_phone') {
      filteredOtherPhone += 1
    }
    if (c.advance) {
      maxApplied = Math.max(maxApplied, nid)
    }
  }
  noteState.set(lid, { warmed: true, lastNoteId: Math.max(st.lastNoteId, maxApplied) })
  if (pushed > 0) {
    console.log(`[kommo-poll][notes] buffer +${pushed} lead=${lid} session=${sessionId}`)
  } else if (fresh.length > 0) {
    const freshHasCommon = fresh.some((n) => String(n?.note_type || '').toLowerCase() === 'common')
    let hint = ''
    if (freshHasCommon && !isCommonInboundEnabled(env)) {
      hint =
        ' | DICA: notas "common" (tipico WhatsApp no Kommo) estao fora do filtro. ' +
        'Remova common de KOMMO_INBOUND_POLL_NOTE_TYPES ou defina KOMMO_INBOUND_POLL_INCLUDE_COMMON=false explicitamente; ' +
        'com common na lista, INCLUDE_COMMON vazio = ligado.'
    }
    console.log(
      `[kommo-poll][notes] sem inbound novo lead=${lid} fresh=${fresh.length} tipos=${JSON.stringify(typeCounts)} filtroAtivo=${types.join('|')}${hint}`,
    )
  }
  recordNotesTick({
    leadId: lid,
    sessionId,
    warmedUp: true,
    notesTotal: notes.length,
    typeCounts,
    freshCount: fresh.length,
    pushedCount: pushed,
    filteredByType,
    filteredEmpty,
    filteredOutbound,
    filteredOtherPhone,
    lastNoteId: Math.max(st.lastNoteId, maxApplied),
    pollMode: 'notes',
  })
  if (isKommoInboundPollDebugLead(env, lid)) {
    console.log(
      `[kommo-poll][debug] notes lead=${lid} notesTotal=${notes.length} fresh=${fresh.length} pushed=${pushed} ` +
        `filteredByType=${filteredByType} filteredEmpty=${filteredEmpty} lastNoteId=${Math.max(st.lastNoteId, maxApplied)} types=${JSON.stringify(typeCounts)}`,
    )
  }
  return pushed
}

function parseEventTypes(env) {
  const raw = String(env.KOMMO_INBOUND_POLL_EVENT_TYPES || 'incoming_chat_message').trim()
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function countEventTypes(events) {
  const out = {}
  for (const e of events) {
    const t = String(e?.type || 'unknown').toLowerCase()
    out[t] = (out[t] || 0) + 1
  }
  return out
}

/**
 * Extrai o texto da mensagem do `value_after` / `value_before` do evento.
 * WABA costuma mandar em `value_after` só stubs `{ message: { id, talk_id, origin: waba } }`
 * sem `text` — aí o texto vem do histórico Amojo (ver resolveWabaInboundTextFromAmojo).
 */
function extractEventMessage(ev) {
  const candidates = []
  for (const raw of [ev?.value_after, ev?.value_before]) {
    if (raw == null) continue
    if (Array.isArray(raw)) {
      for (const item of raw) candidates.push(item)
    } else if (typeof raw === 'object') {
      candidates.push(raw)
    }
  }
  let stubMessageId = null
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    const m = c.message || c.note || c
    const messageId = m?.id ?? c?.id ?? null
    const text = m?.text ?? m?.body ?? m?.content ?? c.text ?? c.body ?? c.content
    if (text != null && String(text).trim()) {
      return { text: String(text).trim(), messageId: messageId ? String(messageId) : null }
    }
    if (m && typeof m === 'object' && (m.id != null || m.talk_id != null)) {
      stubMessageId = messageId != null ? String(messageId) : stubMessageId
    }
  }
  return { text: '', messageId: stubMessageId }
}

/** Dígitos do telefone a partir de `5511...@s.whatsapp.net`. */
function sessionToContactDigits(sessionId) {
  const local = String(sessionId || '').split('@')[0] || ''
  return normalizeDigits(local)
}

/**
 * Evento WABA: `value_after` com message.id + talk_id, sem texto.
 * @returns {{ talkId: number, messageId: string } | null}
 */
function extractWabaRelayRefs(ev) {
  const tryBlock = (raw) => {
    const items = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
    for (const item of items) {
      const msg = item?.message
      if (!msg || typeof msg !== 'object') continue
      const origin = String(msg.origin || '').toLowerCase()
      const tid = msg.talk_id ?? msg.talkId
      const mid = msg.id
      if (tid == null || tid === '') continue
      const talkId = Number(tid)
      if (!Number.isFinite(talkId) || talkId <= 0) continue
      if (
        origin &&
        origin !== 'waba' &&
        origin !== 'whatsapp' &&
        origin !== 'whatsapp_business'
      ) {
        continue
      }
      return { talkId, messageId: mid != null ? String(mid) : '' }
    }
    return null
  }
  const strict = tryBlock(ev?.value_after) || tryBlock(ev?.value_before)
  if (strict) return strict
  const loose = (raw) => {
    const items = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
    for (const item of items) {
      const msg = item?.message
      if (!msg || typeof msg !== 'object') continue
      const tid = msg.talk_id ?? msg.talkId
      const mid = msg.id
      if (tid == null || tid === '') continue
      const talkId = Number(tid)
      if (!Number.isFinite(talkId) || talkId <= 0) continue
      return { talkId, messageId: mid != null ? String(mid) : '' }
    }
    return null
  }
  return loose(ev?.value_after) || loose(ev?.value_before)
}

/**
 * Preenche texto de evento incoming_chat_message WABA quando o CRM não manda body no evento.
 * Exige KOMMO_CHANNEL_SECRET + KOMMO_CHANNEL_SCOPE_ID (mesmo conjunto do mode=amojo).
 */
async function resolveWabaInboundTextFromAmojo(env, ev, sessionId) {
  const off = String(env.KOMMO_INBOUND_POLL_WABA_AMOJO_FILL ?? 'true').trim().toLowerCase()
  if (off === 'false' || off === '0' || off === 'no') return ''
  if (!amojoConfigured(env)) return ''
  const refs = extractWabaRelayRefs(ev)
  if (!refs) return ''
  const scopeId = String(env.KOMMO_CHANNEL_SCOPE_ID || '').trim()
  const talk = await getTalkById(env, refs.talkId)
  if (!talk.ok || !talk.talk?.chat_id) {
    console.warn(
      `[kommo-poll][events] waba_amojo_fill: getTalkById(${refs.talkId}) falhou:`,
      talk.error || talk.status || '?',
    )
    return ''
  }
  const chatId = String(talk.talk.chat_id)
  const hist = await fetchAmojoChatHistory(env, {
    scopeId,
    conversationId: chatId,
    limit: 50,
    offset: 0,
  })
  if (!hist.ok || !hist.messages?.length) {
    console.warn(
      `[kommo-poll][events] waba_amojo_fill: histórico Amojo falhou/vazio chat_id=${chatId.slice(0, 12)}…:`,
      hist.error || hist.status || '?',
    )
    return ''
  }
  const contactDigits = sessionToContactDigits(sessionId)
  const wantId = refs.messageId
  const rows = [...hist.messages].sort((a, b) => (a.msec_timestamp || 0) - (b.msec_timestamp || 0))
  if (wantId) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      const mid = String(row?.message?.id ?? row?.id ?? '')
      if (mid && mid === wantId) {
        const inner = row?.message
        const t = inner?.text ?? inner?.body ?? inner?.content
        if (t != null && String(t).trim()) {
          console.log(
            `[kommo-poll][events] waba_amojo_fill: texto resolvido msgId=${wantId} chat_id=${chatId.slice(0, 12)}…`,
          )
          return String(t).trim()
        }
      }
    }
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!isAmojoInboundRow(row, contactDigits)) continue
    const inner = row?.message
    const mtype = String(inner?.type || '').toLowerCase()
    if (mtype && mtype !== 'text') continue
    const t = inner?.text ?? inner?.body ?? inner?.content
    if (t != null && String(t).trim()) {
      console.log(
        `[kommo-poll][events] waba_amojo_fill: última inbound text (msgId alvo ausente ou sem match) chat_id=${chatId.slice(0, 12)}…`,
      )
      return String(t).trim()
    }
  }
  return ''
}

const INCOMING_EVENT_TYPES = new Set([
  'incoming_chat_message',
  'incoming_message',
])
const OUTGOING_EVENT_TYPES = new Set([
  'outgoing_chat_message',
  'outgoing_message',
])

/** Kommo: `created_at` em Unix segundos; alguns payloads usam ms. */
function normalizeKommoEventSec(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n > 1_000_000_000_000) return Math.floor(n / 1000)
  return Math.floor(n)
}

/**
 * Eventos do entity=contact podem ter `created_at` um pouco antes do cursor
 * calculado só com eventos do lead — ficavam fora de `fresh` para sempre
 * (merge logava +1, buffer vazio). Incluímos inbound ainda não visto nessa
 * janela. Default 7d; 0 = só at >= cursor (comportamento estrito).
 */
function getEventCatchupWindowSec(env) {
  const raw = env.KOMMO_INBOUND_POLL_EVENT_CATCHUP_SEC
  if (raw == null || String(raw).trim() === '') return 86400 * 7
  const v = Number(raw)
  if (!Number.isFinite(v) || v < 0) return 86400 * 7
  if (v === 0) return 0
  return Math.min(Math.max(v, 60), 86400 * 30)
}

/**
 * Inbound com `id` ainda não processado: pode ter `created_at` anos antes do
 * cursor (API contact vs lead). Sem teto, enfileiraríamos décadas de eventos.
 * Default 10 anos; reduza se precisar (ex.: 86400 = 1 dia).
 */
function getUnseenIncomingMaxAgeSec(env) {
  const v = Number(env.KOMMO_INBOUND_POLL_UNSEEN_INCOMING_MAX_AGE_SEC)
  if (Number.isFinite(v) && v > 0) return Math.min(v, 86400 * 365 * 30)
  return 86400 * 365 * 10
}

/**
 * Log detalhado do poll: `KOMMO_INBOUND_POLL_DEBUG=true` ou lista em
 * `KOMMO_INBOUND_POLL_DEBUG_LEAD_IDS=19884275,21208023`.
 */
export function isKommoInboundPollDebugLead(env, leadId) {
  const flag = String(env.KOMMO_INBOUND_POLL_DEBUG || '').trim().toLowerCase()
  if (flag === 'true' || flag === '1' || flag === 'yes' || flag === 'all') return true
  const raw = String(env.KOMMO_INBOUND_POLL_DEBUG_LEAD_IDS || '').trim()
  if (!raw) return false
  const lid = Number(leadId)
  if (!Number.isFinite(lid) || lid <= 0) return false
  return raw
    .split(/[,\s]+/)
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .includes(lid)
}

function mergeEventsById(primary, secondary) {
  const a = Array.isArray(primary) ? primary : []
  const b = Array.isArray(secondary) ? secondary : []
  const byId = new Map()
  for (const e of a) {
    const id = e?.id != null ? String(e.id) : ''
    if (id) byId.set(id, e)
  }
  let added = 0
  for (const e of b) {
    const id = e?.id != null ? String(e.id) : ''
    if (!id) continue
    if (!byId.has(id)) {
      byId.set(id, e)
      added += 1
    }
  }
  return { merged: [...byId.values()], addedFromSecondary: added }
}

/**
 * Sem Amojo: stub WABA no evento não traz `text`, mas o Kommo costuma espelhar
 * a mensagem nas notas do lead. Cruzamos `created_at` da nota com o do evento.
 * Desligue: KOMMO_INBOUND_POLL_WABA_NOTES_FALLBACK=false
 */
async function resolveWabaStubViaLeadNotes(env, ev, leadId, sessionId) {
  const off = String(env.KOMMO_INBOUND_POLL_WABA_NOTES_FALLBACK ?? 'true').trim().toLowerCase()
  if (off === 'false' || off === '0' || off === 'no') return ''
  if (!extractWabaRelayRefs(ev)) return ''
  const lid = Number(leadId)
  if (!Number.isFinite(lid) || lid <= 0) return ''
  const types = parseNoteTypes(env)
  const win = Number(env.KOMMO_INBOUND_POLL_WABA_NOTE_TIME_WINDOW_SEC)
  const windowSec = Number.isFinite(win) && win > 0 ? Math.min(win, 7200) : 900
  const nowSec = Math.floor(Date.now() / 1000)
  const evAt = normalizeKommoEventSec(ev?.created_at)
  const list = await listLeadNotes(env, lid, { limit: 40, order: 'desc' })
  if (!list.ok || !list.notes?.length) return ''
  const contactDigits = sessionToContactDigits(sessionId)
  for (const n of list.notes) {
    const nt = String(n.note_type || '').toLowerCase()
    if (!types.includes(nt)) continue
    if (nt === 'common' && !isCommonInboundEnabled(env)) continue
    const raw = extractNoteText(n, env)
    if (!raw) continue
    if (nt === 'common' && isAgentOutboundEcho(raw)) continue
    const text = stripExecutionSuffix(raw)
    if (!text) continue
    if (nt === 'sms_in' && contactDigits) {
      const np = normalizeDigits(n.params?.phone || '')
      if (np && !phoneDigitsMatch(np, contactDigits)) continue
    }
    const nAt = normalizeKommoEventSec(n.created_at)
    if (evAt > 0 && evAt >= nowSec - 86400 * 800) {
      if (Math.abs(nAt - evAt) > windowSec) continue
    } else {
      if (nAt < nowSec - 900) continue
    }
    const nid = n.id != null ? String(n.id) : ''
    console.log(
      `[kommo-poll][events] waba_notes_fallback lead=${lid} noteId=${nid || 'n/a'} type=${nt} janela=${windowSec}s texto="${text.slice(0, 80)}"`,
    )
    return text
  }
  return ''
}

async function pollEvents(env, leadId, sessionId, contactId) {
  const lid = Number(leadId)
  const types = parseEventTypes(env)
  let st = eventState.get(lid) || {
    warmed: false,
    lastSeenAt: 0,
    seenIds: new Set(),
  }

  const cursorSec = normalizeKommoEventSec(st.lastSeenAt)
  const fromTs =
    st.warmed && cursorSec > 0 ? Math.max(0, cursorSec - 1) : 0
  const list = await listLeadEvents(env, lid, { types, fromTs, limit: 50 })

  if (!list.ok) {
    const errMsg = String(list.error || list.status || 'unknown')
    console.warn(
      `[kommo-poll][events] lead=${lid} api ERRO: ${errMsg} url=${list.requestUrl || 'n/a'}`,
    )
    recordEventsTick({
      leadId: lid,
      sessionId,
      warmedUp: st.warmed,
      eventsTotal: 0,
      typeCounts: {},
      freshCount: 0,
      pushedCount: 0,
      filteredEmpty: 0,
      filteredOutbound: 0,
      filteredOtherType: 0,
      lastSeenAt: st.lastSeenAt,
      pollMode: 'events',
      requestUrl: list.requestUrl || null,
      error: errMsg,
      httpStatus: list.status || null,
    })
    return 0
  }

  let events = list.events || []
  const cid = contactId != null && Number.isFinite(Number(contactId)) ? Number(contactId) : 0
  if (cid > 0) {
    const listC = await listLeadEvents(env, lid, {
      entity: 'contact',
      entityId: cid,
      types,
      fromTs,
      limit: 50,
    })
    if (listC.ok) {
      const { merged, addedFromSecondary } = mergeEventsById(events, listC.events || [])
      if (addedFromSecondary > 0) {
        console.log(
          `[kommo-poll][events] lead=${lid}: mesclados +${addedFromSecondary} evento(s) extra(s) entity=contact contactId=${cid} (podem ser mais recentes que o log do lead; cursor=${cursorSec}s)`,
        )
      }
      events = merged
    } else {
      console.warn(
        `[kommo-poll][events] lead=${lid} poll contact=${cid} falhou:`,
        listC.error || listC.status || 'unknown',
      )
    }
  }

  const typeCounts = countEventTypes(events)

  if (!st.warmed) {
    const maxAt = events.reduce((m, e) => Math.max(m, normalizeKommoEventSec(e?.created_at)), 0)
    const seedAt = maxAt > 0 ? maxAt : Math.floor(Date.now() / 1000)
    // NÃO colocar incoming_chat_message / incoming_message em seenIds no warmup:
    // o warmup não roda extract/Amojo/push — só define o cursor. Se marcar incoming
    // como "visto", eventos WABA (stub sem texto no value_after) ficam bloqueados
    // para sempre (mesclados +1, buffer vazio).
    const seenIds = new Set()
    for (const e of events) {
      const id = e?.id != null ? String(e.id) : ''
      if (!id) continue
      const t = String(e?.type || '').toLowerCase()
      if (!INCOMING_EVENT_TYPES.has(t)) {
        seenIds.add(id)
      }
    }
    eventState.set(lid, {
      warmed: true,
      lastSeenAt: seedAt,
      seenIds,
    })
    console.log(
      `[kommo-poll][events] warmup lead=${lid} session=${sessionId} lastSeenAt=${seedAt} eventos=${events.length} tipos=${JSON.stringify(typeCounts)} seenIdsNaoIncoming=${seenIds.size} url=${list.requestUrl || 'n/a'}`,
    )
    recordEventsTick({
      leadId: lid,
      sessionId,
      warmedUp: false,
      eventsTotal: events.length,
      typeCounts,
      freshCount: 0,
      pushedCount: 0,
      filteredEmpty: 0,
      filteredOutbound: 0,
      filteredOtherType: 0,
      lastSeenAt: seedAt,
      pollMode: 'events',
      requestUrl: list.requestUrl || null,
      httpStatus: list.status || null,
    })
    return 0
  }

  const cursor = normalizeKommoEventSec(st.lastSeenAt)
  const catchupSec = getEventCatchupWindowSec(env)
  const catchupFloor = catchupSec > 0 ? Math.max(0, cursor - catchupSec) : cursor
  const nowSec = Math.floor(Date.now() / 1000)
  const unseenIncomingAgeFloor = Math.max(0, nowSec - getUnseenIncomingMaxAgeSec(env))

  const fresh = events.filter((e) => {
    const id = e?.id != null ? String(e.id) : ''
    if (id && st.seenIds.has(id)) return false
    const at = normalizeKommoEventSec(e?.created_at)
    const t = String(e?.type || '').toLowerCase()
    if (INCOMING_EVENT_TYPES.has(t) && id) {
      if (at >= unseenIncomingAgeFloor) return true
      return at >= cursor || (catchupSec > 0 && at >= catchupFloor)
    }
    return at >= cursor
  })

  if (isKommoInboundPollDebugLead(env, lid)) {
    const samp = events
      .filter((e) => INCOMING_EVENT_TYPES.has(String(e?.type || '').toLowerCase()))
      .slice(0, 14)
      .map((e) => ({
        id: e?.id != null ? String(e.id) : '',
        at: normalizeKommoEventSec(e?.created_at),
        seen: Boolean(e?.id != null && st.seenIds.has(String(e.id))),
        inFresh: fresh.some((x) => String(x?.id) === String(e?.id)),
      }))
    console.log(
      `[kommo-poll][debug] events lead=${lid} session=${String(sessionId).slice(0, 32)}… ` +
        `cursor=${cursor} catchupSec=${catchupSec} catchupFloor=${catchupFloor} unseenAgeFloor=${unseenIncomingAgeFloor} ` +
        `events=${events.length} fresh=${fresh.length} seenIds=${st.seenIds.size} sample=${JSON.stringify(samp)}`,
    )
  }

  const asc = [...fresh].sort(
    (a, b) => normalizeKommoEventSec(a?.created_at) - normalizeKommoEventSec(b?.created_at),
  )

  let pushed = 0
  let maxAt = cursor
  let filteredEmpty = 0
  let filteredOutbound = 0
  let filteredOtherType = 0

  for (const ev of asc) {
    const at = normalizeKommoEventSec(ev?.created_at)
    const t = String(ev?.type || '').toLowerCase()
    const evId = ev?.id != null ? String(ev.id) : ''

    if (OUTGOING_EVENT_TYPES.has(t)) {
      filteredOutbound += 1
      if (evId) st.seenIds.add(evId)
      maxAt = Math.max(maxAt, at)
      continue
    }

    if (!INCOMING_EVENT_TYPES.has(t)) {
      filteredOtherType += 1
      if (evId) st.seenIds.add(evId)
      maxAt = Math.max(maxAt, at)
      continue
    }

    let { text, messageId } = extractEventMessage(ev)
    if (!text) {
      text = await resolveWabaInboundTextFromAmojo(env, ev, sessionId)
    }
    if (!text) {
      text = await resolveWabaStubViaLeadNotes(env, ev, lid, sessionId)
    }
    if (!text) {
      filteredEmpty += 1
      if (evId) st.seenIds.add(evId)
      maxAt = Math.max(maxAt, at)
      const vaShape = Array.isArray(ev?.value_after)
        ? `array[${ev.value_after.length}]`
        : ev?.value_after && typeof ev.value_after === 'object'
          ? `object{${Object.keys(ev.value_after).join(',')}}`
          : ev?.value_after === null
            ? 'null'
            : typeof ev?.value_after
      let preview = ''
      try {
        preview = JSON.stringify(ev?.value_after ?? null).slice(0, 280)
      } catch {
        preview = '(unserializable)'
      }
      console.log(
        `[kommo-poll][events] sem_texto lead=${lid} eventId=${evId} type=${t} createdAt=${at} value_after=${vaShape} preview=${preview}` +
          (amojoConfigured(env)
            ? ' | Amojo tentado; sem texto. Verifique assinatura Amojo / histórico. Ou notas: INCLUDE_COMMON + common em NOTE_TYPES e WABA_NOTES_FALLBACK.'
            : ' | Sem KOMMO_CHANNEL_SECRET/SCOPE_ID (Amojo). Fallback notas: INCLUDE_COMMON=true, common em NOTE_TYPES (WABA_NOTES_FALLBACK default ligado).'),
      )
      continue
    }

    if (isAgentOutboundEcho(text)) {
      filteredOutbound += 1
      if (evId) st.seenIds.add(evId)
      maxAt = Math.max(maxAt, at)
      continue
    }

    const cleaned = stripExecutionSuffix(text)
    if (!cleaned) {
      filteredEmpty += 1
      if (evId) st.seenIds.add(evId)
      maxAt = Math.max(maxAt, at)
      continue
    }

    try {
      await pushMessage(env, sessionId, cleaned, { skipDedupe: true })
      pushed += 1
      if (evId) st.seenIds.add(evId)
      maxAt = Math.max(maxAt, at)
      console.log(
        `[kommo-poll][events] +1 lead=${lid} session=${sessionId} eventId=${evId} msgId=${messageId || 'n/a'} createdAt=${at} text="${cleaned.slice(0, 80)}"`,
      )
    } catch (err) {
      console.error(
        `[kommo-poll][events] pushMessage falhou lead=${lid} eventId=${evId}: ${err.message}`,
      )
    }
  }

  if (st.seenIds.size > 200) {
    const arr = [...st.seenIds]
    st.seenIds = new Set(arr.slice(-100))
  }

  eventState.set(lid, {
    warmed: true,
    lastSeenAt: Math.max(normalizeKommoEventSec(st.lastSeenAt), maxAt),
    seenIds: st.seenIds,
  })

  if (pushed > 0) {
    console.log(
      `[kommo-poll][events] buffer +${pushed} lead=${lid} session=${sessionId} (eventos vistos=${events.length})`,
    )
  } else if (fresh.length > 0) {
    console.log(
      `[kommo-poll][events] sem inbound novo lead=${lid} fresh=${fresh.length} tipos=${JSON.stringify(typeCounts)} filtroAtivo=${types.join('|')}`,
    )
  }

  recordEventsTick({
    leadId: lid,
    sessionId,
    warmedUp: true,
    eventsTotal: events.length,
    typeCounts,
    freshCount: fresh.length,
    pushedCount: pushed,
    filteredEmpty,
    filteredOutbound,
    filteredOtherType,
    lastSeenAt: Math.max(normalizeKommoEventSec(st.lastSeenAt), maxAt),
    pollMode: 'events',
    requestUrl: list.requestUrl || null,
    httpStatus: list.status || null,
  })
  if (isKommoInboundPollDebugLead(env, lid)) {
    console.log(
      `[kommo-poll][debug] events resultado lead=${lid} pushed=${pushed} filteredEmpty=${filteredEmpty} outbound=${filteredOutbound} otherType=${filteredOtherType} newLastSeen=${Math.max(normalizeKommoEventSec(st.lastSeenAt), maxAt)}`,
    )
  }
  return pushed
}

/**
 * Tipos do dispatcher (kommo-chat-sync) considerados inbound.
 * Apenas `contact` é o cliente. `user` = operador humano, `bot` = nossa IA.
 */
const DISPATCHER_INBOUND_SENDER_TYPES = new Set(['contact'])
/**
 * Tipos puramente texto — vão direto pro buffer.
 */
const DISPATCHER_TEXT_TYPES = new Set(['text'])
/**
 * Tipos de áudio/voz — passamos por Whisper antes de empurrar pro buffer.
 * (`voice` é o nome canônico do dispatcher; `audio` aparece em variações.)
 */
const DISPATCHER_VOICE_TYPES = new Set(['voice', 'audio'])
/**
 * Tipos de imagem — passamos por Vision (gpt-4o) antes de empurrar.
 * (`picture` é o nome do dispatcher; `image` aparece em variações.)
 */
const DISPATCHER_PICTURE_TYPES = new Set(['picture', 'image'])

/**
 * Mapeia mimetype/URL → nome de arquivo com extensão correta.
 * Whisper API usa a EXTENSÃO do filename pra detectar o formato; se a
 * gente mandar conteúdo .m4a com nome .ogg, ele tenta decodificar
 * como ogg e estoura. Kommo costuma servir .m4a (audio/mp4) pra
 * gravações da Cloud API.
 */
function deriveAudioFilename(mimeType, urlOrName) {
  const m = String(mimeType || '').toLowerCase()
  if (m.includes('m4a')) return 'voice.m4a'
  if (m.includes('mp4') || m.includes('aac')) return 'voice.m4a'
  if (m.includes('mp3') || m.includes('mpeg')) return 'voice.mp3'
  if (m.includes('webm')) return 'voice.webm'
  if (m.includes('wav')) return 'voice.wav'
  if (m.includes('flac')) return 'voice.flac'
  if (m.includes('ogg') || m.includes('opus')) return 'voice.ogg'
  // Fallback: tenta achar uma extensão na URL/nome (ex.: .../file.m4a).
  const s = String(urlOrName || '')
  const match = s.match(/\.([a-z0-9]{2,4})(?:\?|$)/i)
  if (match) {
    const ext = match[1].toLowerCase()
    if (['m4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'ogg', 'wav', 'webm', 'flac'].includes(ext)) {
      return `voice.${ext}`
    }
  }
  // Última opção — ogg cobre o caso Baileys/WhatsApp Cloud direto.
  return 'voice.ogg'
}

/**
 * Processa uma mensagem de áudio do dispatcher: baixa via media_url,
 * transcreve com Whisper, devolve texto pronto pra empurrar no buffer.
 * Garante que SEMPRE devolve algum texto — mesmo em falha — pra IA não
 * ficar muda (Rule 15 do prompt).
 */
async function transcribeDispatcherVoice(env, msg, leadId) {
  const url = msg?.media_url
  if (!url) {
    console.warn(`[kommo-poll][dispatcher] voice sem media_url lead=${leadId} msgId=${msg?.id}`)
    return '[ÁUDIO RECEBIDO mas o dispatcher não devolveu URL — peça desculpas e diga que vai pedir pra um consultor escutar.]'
  }
  const dl = await downloadUrlAsBase64(env, url)
  if (!dl.ok) {
    console.error(
      `[kommo-poll][dispatcher] download voice falhou lead=${leadId} msgId=${msg?.id} url=${url} (${dl.code || dl.status}): ${dl.error} attempts=${(dl.attempts || []).join(',')}`,
    )
    return '[ÁUDIO RECEBIDO mas o download falhou — peça desculpas e diga que vai pedir pra um consultor escutar ou peça pro lead reenviar/digitar a mensagem.]'
  }
  const filename = deriveAudioFilename(dl.mimeType, url)
  console.log(
    `[kommo-poll][dispatcher] download voice OK lead=${leadId} msgId=${msg?.id} ${dl.bytes}B mime=${dl.mimeType || 'n/a'} filename=${filename} via ${(dl.attempts || []).join(',')}`,
  )
  try {
    const txt = await transcribeAudioBase64(env, dl.base64, {
      filename,
      mimeType: dl.mimeType || 'audio/ogg',
    })
    if (!txt || !txt.trim()) {
      return '[ÁUDIO RECEBIDO mas a transcrição ficou vazia — peça ao lead pra reenviar ou digitar a mensagem.]'
    }
    return `[ÁUDIO TRANSCRITO]: ${txt.trim()}`
  } catch (e) {
    console.error(
      `[kommo-poll][dispatcher] whisper falhou lead=${leadId} msgId=${msg?.id} filename=${filename} mime=${dl.mimeType || 'n/a'}: ${e.message}`,
    )
    return '[ÁUDIO RECEBIDO mas houve falha técnica na transcrição — peça desculpas e diga que vai pedir pra um consultor escutar.]'
  }
}

/**
 * Processa uma mensagem de imagem do dispatcher: baixa via media_url,
 * analisa com Vision, devolve texto pronto pra empurrar no buffer.
 */
async function analyzeDispatcherPicture(env, msg, leadId) {
  const url = msg?.media_url
  const caption = String(msg?.message_text || '').trim()
  if (!url) {
    console.warn(`[kommo-poll][dispatcher] picture sem media_url lead=${leadId} msgId=${msg?.id}`)
    return caption
      ? `[IMAGEM RECEBIDA mas o dispatcher não devolveu URL. Legenda do lead: "${caption}". Peça desculpas e diga que vai pedir pra um consultor analisar.]`
      : '[IMAGEM RECEBIDA mas o dispatcher não devolveu URL. Peça desculpas e diga que vai pedir pra um consultor analisar.]'
  }
  const dl = await downloadUrlAsBase64(env, url)
  if (!dl.ok) {
    console.error(
      `[kommo-poll][dispatcher] download picture falhou lead=${leadId} msgId=${msg?.id} url=${url} (${dl.code || dl.status}): ${dl.error} attempts=${(dl.attempts || []).join(',')}`,
    )
    return caption
      ? `[IMAGEM RECEBIDA mas o download falhou. Legenda do lead: "${caption}". Diga que vai pedir pra um consultor olhar.]`
      : '[IMAGEM RECEBIDA mas o download falhou. Diga que vai pedir pra um consultor olhar.]'
  }
  console.log(
    `[kommo-poll][dispatcher] download picture OK lead=${leadId} msgId=${msg?.id} ${dl.bytes}B mime=${dl.mimeType || 'n/a'} via ${(dl.attempts || []).join(',')}`,
  )
  try {
    const analysis = await analyzeImageBase64(env, dl.base64, {
      mimeType: dl.mimeType || 'image/jpeg',
    })
    const clean = String(analysis || '').trim()
    if (!clean) {
      return caption
        ? `[IMAGEM RECEBIDA mas a análise visual ficou vazia. Legenda do lead: "${caption}".]`
        : '[IMAGEM RECEBIDA mas a análise visual ficou vazia. Peça ao lead pra reenviar ou descrever em texto.]'
    }
    return caption ? `${clean}\n\n[Legenda do lead na imagem]: ${caption}` : clean
  } catch (e) {
    console.error(
      `[kommo-poll][dispatcher] vision falhou lead=${leadId} msgId=${msg?.id}: ${e.message}`,
    )
    return caption
      ? `[IMAGEM RECEBIDA mas houve falha técnica ao analisá-la. Legenda do lead: "${caption}". Diga que vai pedir pra um consultor olhar.]`
      : '[IMAGEM RECEBIDA mas houve falha técnica ao analisá-la. Diga que vai pedir pra um consultor olhar.]'
  }
}

function countDispatcherStats(messages) {
  const senderTypes = {}
  const messageTypes = {}
  for (const m of messages) {
    const st = String(m?.sender_type || 'unknown').toLowerCase()
    const mt = String(m?.message_type || 'unknown').toLowerCase()
    senderTypes[st] = (senderTypes[st] || 0) + 1
    messageTypes[mt] = (messageTypes[mt] || 0) + 1
  }
  return { senderTypes, messageTypes }
}

/**
 * Janela em segundos pra considerar uma mensagem "recente" no warmup.
 * No primeiro tick após deploy/restart, mensagens dentro dessa janela
 * SÃO processadas — só descartamos histórico de fato antigo. Sem isso,
 * o warmup engolia exatamente a mensagem que acabou de chegar (caso
 * comum: lead movido pra "Agente AI receptivo" segundos depois de
 * mandar áudio → primeiro tick do scheduler virava warmup → áudio
 * desaparecia).
 *
 * 120s cobre o caso normal (mensagem chegou enquanto o deploy ainda
 * estava subindo) sem reprocessar minutos de histórico.
 */
function getWarmupFreshSec(env) {
  const v = Number(env.KOMMO_INBOUND_WARMUP_FRESH_SEC)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 120
}

function parseSentAtSec(value) {
  if (value == null) return 0
  const d = new Date(value)
  const ms = d.getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.floor(ms / 1000)
}

async function pollDispatcher(env, leadId, sessionId) {
  const lid = Number(leadId)
  let st = dispatcherState.get(lid) || { warmed: false, lastMsgId: 0, seenIds: new Set() }
  const list = await dispatcherGetMessagesByLead(env, lid, { limit: 30, order: 'desc' })

  if (!list.ok) {
    const errMsg = String(list.error || list.status || 'unknown')
    console.warn(
      `[kommo-poll][dispatcher] lead=${lid} api ERRO: ${errMsg} cause=${list.cause || 'n/a'} url=${list.requestUrl || 'n/a'} elapsed=${list.elapsedMs ?? '?'}ms${list.hint ? ` hint=${list.hint}` : ''}`,
    )
    recordDispatcherTick({
      leadId: lid,
      sessionId,
      warmedUp: st.warmed,
      messagesTotal: 0,
      stats: { senderTypes: {}, messageTypes: {} },
      freshCount: 0,
      pushedCount: 0,
      filteredOutbound: 0,
      filteredNonText: 0,
      filteredEmpty: 0,
      lastMsgId: st.lastMsgId,
      pollMode: 'dispatcher',
      requestUrl: list.requestUrl || null,
      httpStatus: list.status || null,
      elapsedMs: list.elapsedMs || null,
      error: errMsg,
    })
    return 0
  }

  const messages = list.messages || []
  const stats = countDispatcherStats(messages)

  if (!st.warmed) {
    const maxId = messages.reduce((m, x) => Math.max(m, Number(x?.id) || 0), 0)
    const freshSec = getWarmupFreshSec(env)
    const nowSec = Math.floor(Date.now() / 1000)
    // Pra evitar reprocessar histórico antigo, só consideramos mensagens
    // com sent_at dentro da janela. Se freshSec=0, o warmup volta a se
    // comportar como antes (descartar tudo).
    let warmupCutoffId = maxId
    if (freshSec > 0) {
      const cutoff = nowSec - freshSec
      const oldEnough = messages.filter((m) => {
        const sec = parseSentAtSec(m?.sent_at)
        return sec > 0 && sec < cutoff
      })
      // lastMsgId vira o maior id ENTRE as mensagens antigas; assim,
      // mensagens dentro da janela ficam fresh e são processadas pelo
      // loop normal abaixo.
      warmupCutoffId = oldEnough.reduce((m, x) => Math.max(m, Number(x?.id) || 0), 0)
    }
    dispatcherState.set(lid, { warmed: true, lastMsgId: warmupCutoffId, seenIds: new Set() })
    console.log(
      `[kommo-poll][dispatcher] warmup lead=${lid} session=${sessionId} lastMsgId=${warmupCutoffId} (de ${maxId}) freshSec=${freshSec} mensagens=${messages.length} stats=${JSON.stringify(stats)} elapsed=${list.elapsedMs ?? '?'}ms`,
    )
    // Atualiza o `st` em memória pra o loop abaixo enxergar o novo
    // lastMsgId. Sem isso, o `fresh.filter` usaria o `st` antigo (com
    // lastMsgId = 0) e processaria histórico inteiro.
    st = { warmed: true, lastMsgId: warmupCutoffId, seenIds: new Set() }
    // CONTINUA pro loop abaixo — não retorna 0 cedo. As mensagens
    // dentro da janela `freshSec` (id > warmupCutoffId) são tratadas
    // como fresh e empurradas normalmente. O recordDispatcherTick é
    // chamado UMA vez no fim com os totais corretos.
  }

  const fresh = messages.filter((m) => {
    const mid = Number(m?.id) || 0
    if (mid <= st.lastMsgId) return false
    if (st.seenIds.has(mid)) return false
    return true
  })
  const asc = [...fresh].sort((a, b) => (Number(a?.id) || 0) - (Number(b?.id) || 0))

  let pushed = 0
  let filteredOutbound = 0
  let filteredNonText = 0
  let filteredEmpty = 0
  let maxApplied = st.lastMsgId

  for (const m of asc) {
    const mid = Number(m?.id) || 0
    const senderType = String(m?.sender_type || '').toLowerCase()
    const messageType = String(m?.message_type || '').toLowerCase()
    const text = String(m?.message_text || '').trim()

    if (!DISPATCHER_INBOUND_SENDER_TYPES.has(senderType)) {
      filteredOutbound += 1
      st.seenIds.add(mid)
      maxApplied = Math.max(maxApplied, mid)
      continue
    }

    // Áudio/voz → Whisper. Empurra a transcrição (com marcador entre
    // colchetes, igual o webhook Evolution faz, pra IA seguir Rule 15).
    if (DISPATCHER_VOICE_TYPES.has(messageType)) {
      try {
        const transcribed = await transcribeDispatcherVoice(env, m, lid)
        await pushMessage(env, sessionId, transcribed, { skipDedupe: true })
        pushed += 1
        st.seenIds.add(mid)
        maxApplied = Math.max(maxApplied, mid)
        console.log(
          `[kommo-poll][dispatcher] +1 voz lead=${lid} session=${sessionId} msgId=${mid} sender="${m?.sender_name || senderType}" sentAt=${m?.sent_at || 'n/a'} text="${transcribed.slice(0, 100)}"`,
        )
      } catch (err) {
        console.error(
          `[kommo-poll][dispatcher] processar voz falhou lead=${lid} msgId=${mid}: ${err.message}`,
        )
        // Mesmo em exceção inesperada, marca como vista pra não ficar
        // re-tentando infinito a cada tick.
        st.seenIds.add(mid)
        maxApplied = Math.max(maxApplied, mid)
      }
      continue
    }

    // Imagem → Vision.
    if (DISPATCHER_PICTURE_TYPES.has(messageType)) {
      try {
        const described = await analyzeDispatcherPicture(env, m, lid)
        await pushMessage(env, sessionId, described, { skipDedupe: true })
        pushed += 1
        st.seenIds.add(mid)
        maxApplied = Math.max(maxApplied, mid)
        console.log(
          `[kommo-poll][dispatcher] +1 imagem lead=${lid} session=${sessionId} msgId=${mid} sender="${m?.sender_name || senderType}" sentAt=${m?.sent_at || 'n/a'} text="${described.slice(0, 100)}"`,
        )
      } catch (err) {
        console.error(
          `[kommo-poll][dispatcher] processar imagem falhou lead=${lid} msgId=${mid}: ${err.message}`,
        )
        st.seenIds.add(mid)
        maxApplied = Math.max(maxApplied, mid)
      }
      continue
    }

    if (!DISPATCHER_TEXT_TYPES.has(messageType)) {
      filteredNonText += 1
      st.seenIds.add(mid)
      maxApplied = Math.max(maxApplied, mid)
      console.log(
        `[kommo-poll][dispatcher] ignorando tipo não suportado lead=${lid} msgId=${mid} type=${messageType} sender=${m?.sender_name || senderType}`,
      )
      continue
    }

    if (!text) {
      filteredEmpty += 1
      st.seenIds.add(mid)
      maxApplied = Math.max(maxApplied, mid)
      continue
    }

    if (isAgentOutboundEcho(text)) {
      filteredOutbound += 1
      st.seenIds.add(mid)
      maxApplied = Math.max(maxApplied, mid)
      continue
    }

    const cleaned = stripExecutionSuffix(text)
    if (!cleaned) {
      filteredEmpty += 1
      st.seenIds.add(mid)
      maxApplied = Math.max(maxApplied, mid)
      continue
    }

    try {
      await pushMessage(env, sessionId, cleaned, { skipDedupe: true })
      pushed += 1
      st.seenIds.add(mid)
      maxApplied = Math.max(maxApplied, mid)
      console.log(
        `[kommo-poll][dispatcher] +1 lead=${lid} session=${sessionId} msgId=${mid} sender="${m?.sender_name || senderType}" sentAt=${m?.sent_at || 'n/a'} origin=${m?.origin || 'n/a'} text="${cleaned.slice(0, 80)}"`,
      )
    } catch (err) {
      console.error(
        `[kommo-poll][dispatcher] pushMessage falhou lead=${lid} msgId=${mid}: ${err.message}`,
      )
    }
  }

  if (st.seenIds.size > 200) {
    const arr = [...st.seenIds]
    st.seenIds = new Set(arr.slice(-100))
  }

  dispatcherState.set(lid, {
    warmed: true,
    lastMsgId: Math.max(st.lastMsgId, maxApplied),
    seenIds: st.seenIds,
  })

  if (pushed > 0) {
    console.log(
      `[kommo-poll][dispatcher] buffer +${pushed} lead=${lid} session=${sessionId} (mensagens vistas=${messages.length})`,
    )
  } else if (fresh.length > 0) {
    console.log(
      `[kommo-poll][dispatcher] sem inbound novo lead=${lid} fresh=${fresh.length} stats=${JSON.stringify(stats)}`,
    )
  }

  recordDispatcherTick({
    leadId: lid,
    sessionId,
    warmedUp: true,
    messagesTotal: messages.length,
    stats,
    freshCount: fresh.length,
    pushedCount: pushed,
    filteredOutbound,
    filteredNonText,
    filteredEmpty,
    lastMsgId: Math.max(st.lastMsgId, maxApplied),
    pollMode: 'dispatcher',
    requestUrl: list.requestUrl || null,
    httpStatus: list.status || null,
    elapsedMs: list.elapsedMs || null,
  })
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
    recordAmojoTick({ leadId: lid, sessionId, ok: false, messages: 0, error: 'sem_chat_id' })
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
    recordAmojoTick({
      leadId: lid,
      sessionId,
      ok: false,
      messages: 0,
      error: String(hist.error || hist.status || 'erro'),
    })
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
    await pushMessage(env, sessionId, text, { skipDedupe: true })
    lastM = Math.max(lastM, row.msec_timestamp || 0)
    pushed += 1
  }
  amojoState.set(lid, { warmed: true, lastMsec: lastM })
  if (pushed > 0) {
    console.log(`[kommo-poll][amojo] buffer +${pushed} lead=${lid} session=${sessionId}`)
  }
  recordAmojoTick({ leadId: lid, sessionId, ok: true, messages: rows.length })
  return pushed
}

/**
 * @param {Record<string,string>} env
 * @param {{ leadId: number, sessionId: string, phone: string }} p
 * @returns { Promise<{ pushed: number, byMode: Record<string, number> }> }
 */
export async function syncKommoInboundToBuffer(env, { leadId, sessionId, phone, contactId }) {
  if (!pollEnabled(env)) return { pushed: 0, byMode: {} }
  const mode = pollMode(env)
  const contactDigits = normalizeDigits(phone)
  const byMode = {}
  let pushed = 0

  const runNotes = async () => {
    const n = await pollNotes(env, leadId, sessionId, contactDigits)
    byMode.notes = n
    pushed += n
  }
  const runEvents = async () => {
    const n = await pollEvents(env, leadId, sessionId, contactId)
    byMode.events = n
    pushed += n
  }
  const runDispatcher = async () => {
    const n = await pollDispatcher(env, leadId, sessionId)
    byMode.dispatcher = n
    pushed += n
  }
  const runAmojo = async () => {
    if (!amojoConfigured(env)) {
      byMode.amojo = 0
      return
    }
    const n = await pollAmojo(env, leadId, sessionId, contactDigits)
    byMode.amojo = n
    pushed += n
  }

  if (mode === 'dispatcher') {
    await runDispatcher()
    return { pushed, byMode }
  }
  if (mode === 'amojo') {
    if (!amojoConfigured(env)) {
      console.warn('[kommo-poll] mode=amojo mas faltam KOMMO_CHANNEL_SECRET / KOMMO_CHANNEL_SCOPE_ID')
      return { pushed: 0, byMode }
    }
    await runAmojo()
    return { pushed, byMode }
  }
  if (mode === 'events') {
    await runEvents()
    return { pushed, byMode }
  }
  if (mode === 'both') {
    await runNotes()
    if (alsoPollEventsInBoth(env)) {
      await runEvents()
    }
    return { pushed, byMode }
  }
  if (mode === 'all') {
    await runNotes()
    await runEvents()
    await runDispatcher()
    await runAmojo()
    return { pushed, byMode }
  }
  await runNotes()
  if (alsoPollEventsWithNotes(env)) {
    await runEvents()
  }
  return { pushed, byMode }
}
