/**
 * Recupera leads parados por falha de envio (Meta/OpenAI) na fila do agente.
 *
 *   node scripts/recover-outage-queue.mjs --dry-run
 *   node scripts/recover-outage-queue.mjs --apply [--limit N] [--status aguardando|atendimento|all]
 */
import fs from 'node:fs'
import { listLeadsByStatus, bulkGetContactsByIds, extractContactPhone, updateLeadPipelineStatus } from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId, whatsAppSessionVariants } from '../server/phoneWhatsApp.js'
import { getMessages, pushMessage } from '../server/evolution/messageBuffer.js'
import { fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'
import { fetchRecentChatRows } from '../server/historyStore.js'
import { syncKommoInboundToBuffer, resetKommoInboundPollStateForLead } from '../server/kommoInboundPoll.js'
import { isKommoSystemOrIntegrationNote, isLikelyAgentEcho } from '../libShared/inboundMessageSanitize.js'
import { flushSession } from '../server/evolution/webhookEvolution.js'
import { AGENT_FUNNEL_PIPELINE_ID, AGENT_FUNNEL_STATUS_ID } from '../server/kommoAgentFunnelGate.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'
import { listLeadNotes } from '../server/kommoClient.js'
import { sanitizeLeadInboundMessage } from '../libShared/inboundMessageSanitize.js'

const env = { ...process.env }
const envFile = process.env.ENV_FILE || '.env.recovery'
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!env[k]) env[k] = line.slice(i + 1)
  }
}

const args = process.argv.slice(2)
const dryRun = !args.includes('--apply')
const fromOutage = args.includes('--from-outage')
const limit = Number(args.find((a, i) => args[i - 1] === '--limit') || 0) || 0
const statusFilter = args.find((a, i) => args[i - 1] === '--status') || 'all'
const leadIdsArg = args.find((a, i) => args[i - 1] === '--lead-ids')
const filterIds = leadIdsArg
  ? new Set(leadIdsArg.split(',').map((s) => Number(s.trim())).filter((n) => n > 0))
  : null

const PIPE = AGENT_FUNNEL_PIPELINE_ID
const STATUS_ATENDIMENTO = AGENT_FUNNEL_STATUS_ID
const STATUS_INSCRICAO = 106804680
const STATUS_AGUARDANDO = 106377088

const STATUS_MAP = {
  all: [STATUS_ATENDIMENTO, STATUS_INSCRICAO, STATUS_AGUARDANDO],
  atendimento: [STATUS_ATENDIMENTO, STATUS_INSCRICAO],
  aguardando: [STATUS_AGUARDANDO],
}
const statusIds = STATUS_MAP[statusFilter] || STATUS_MAP.all

const SKIP_FORM = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
])

const DEBOUNCE_MS = 6000
const INTER_LEAD_MS = 2500

function analyzeHistory(rows) {
  const chronological = [...(rows || [])].reverse()
  let lastUser = null
  let lastBot = null
  let lastUserAt = null
  let lastBotAt = null
  for (const row of chronological) {
    const u = String(row?.user_message || '').trim()
    const b = String(row?.bot_message || '').trim()
    if (u) {
      lastUser = u
      lastUserAt = row.created_at
    }
    if (b) {
      lastBot = b
      lastBotAt = row.created_at
    }
  }
  const pending =
    Boolean(lastUser) &&
    (!lastBot || (lastUserAt && lastBotAt && lastUserAt > lastBotAt))
  return { lastUser, lastBot, needsReply: pending }
}

async function bufferCount(env, phone) {
  const variants = whatsAppSessionVariants(phone)
  let best = 0
  let bestSid = phoneToWhatsAppSessionId(phone)
  for (const sid of variants) {
    const msgs = await getMessages(env, sid)
    if ((msgs?.length || 0) > best) {
      best = msgs.length
      bestSid = sid
    }
  }
  return { count: best, sessionId: bestSid }
}

function noteText(n) {
  return String(n?.params?.text || n?.params?.message || '').trim()
}

function isOutboundNoteType(t) {
  const x = String(t || '').toLowerCase()
  return x === 'sms_out' || x === 'outgoing_chat_message' || x === 'amomail_message'
}

function classifyNote(n) {
  const raw = noteText(n)
  if (!raw) return { kind: 'skip', reason: 'empty' }
  if (isOutboundNoteType(n.note_type)) return { kind: 'skip', reason: 'outbound_type' }
  if (isLikelyAgentEcho(raw) || isKommoSystemOrIntegrationNote(raw)) {
    return { kind: 'skip', reason: 'echo_or_system' }
  }
  return { kind: 'inbound', text: raw }
}

async function noteNeedsReply(env, leadId) {
  const notesRes = await listLeadNotes(env, leadId, { limit: 12 })
  if (!notesRes.ok) return { needs: false, reason: 'notes_fail' }
  const newest = notesRes.notes?.[0]
  if (!newest) return { needs: false, reason: 'no_notes' }
  const cls = classifyNote(newest)
  if (cls.kind === 'inbound') {
    return { needs: true, reason: 'last_note_inbound', preview: cls.text.slice(0, 60) }
  }
  return { needs: false, reason: `last_note_${cls.reason}` }
}

function pickSeedText(raw) {
  const chunks = String(raw || '')
    .split(/\n+/)
    .map((s) => sanitizeLeadInboundMessage(s.trim()))
    .filter(Boolean)
  const clean = chunks.filter((c) => !/encaminhamento autom[aá]tico/i.test(c))
  return (clean.at(-1) || chunks.at(-1) || '').trim()
}

/** Leads com resposta IA gerada mas WhatsApp falhou (token Meta) desde 10/06. */
async function loadOutageVictims(env) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || ''
  if (!url || !key) return []
  const headers = { apikey: key, Authorization: `Bearer ${key}` }
  const all = []
  for (let off = 0; off < 5000; off += 500) {
    const q =
      `mensagens_ia?error=not.is.null&created_at=gte.2026-06-10T12:00:00` +
      `&select=id,user_message,error,response,usage,created_at&order=created_at.desc&limit=500&offset=${off}`
    const r = await fetch(`${url}/rest/v1/${q}`, { headers })
    const rows = await r.json().catch(() => [])
    if (!Array.isArray(rows) || !rows.length) break
    all.push(...rows)
    if (rows.length < 500) break
  }
  const byLead = new Map()
  for (const row of all) {
    if (!/whatsapp|meta|190|oauth|authentication/i.test(String(row.error || ''))) continue
    const lid = Number(row.usage?.lead_id)
    if (!lid) continue
    const prev = byLead.get(lid)
    if (!prev || row.created_at > prev.created_at) {
      byLead.set(lid, {
        lid,
        phone: row.usage?.telefone || null,
        seed: pickSeedText(row.user_message),
        hadResponse: Boolean(row.response),
        at: row.created_at,
      })
    }
  }
  return [...byLead.values()].filter((x) => x.seed && x.hadResponse)
}

async function listAll(statusId) {
  const out = []
  for (let page = 1; page <= 20; page++) {
    const listing = await listLeadsByStatus(env, { pipelineId: PIPE, statusId, page, limit: 250 })
    if (!listing.ok) break
    out.push(...(listing.leads || []))
    if ((listing.leads || []).length < 250) break
  }
  return out
}

let leads = []
let outageRows = []
if (fromOutage) {
  outageRows = await loadOutageVictims(env)
  if (filterIds?.size) outageRows = outageRows.filter((r) => filterIds.has(r.lid))
  if (limit > 0) outageRows = outageRows.slice(0, limit)
  for (const row of outageRows) {
    const lr = await fetch(
      `${(env.KOMMO_BASE_URL || '').replace(/\/$/, '')}/api/v4/leads/${row.lid}?with=contacts`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${env.KOMMO_ACCESS_TOKEN}` } },
    )
    const lead = await lr.json().catch(() => null)
    if (lead?.id) leads.push({ ...lead, _statusId: Number(lead.status_id), _outageSeed: row.seed })
  }
} else {
  for (const sid of statusIds) {
    const batch = await listAll(sid)
    for (const l of batch) leads.push({ ...l, _statusId: sid })
  }
  if (filterIds?.size) leads = leads.filter((l) => filterIds.has(Number(l.id)))
  if (limit > 0) leads = leads.slice(0, limit)
}

const contactIds = []
for (const l of leads) for (const c of l._embedded?.contacts || []) contactIds.push(Number(c.id))
const bulk = await bulkGetContactsByIds(env, [...new Set(contactIds)])
const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))

const candidates = []
const skipped = []

for (const lead of leads) {
  const lid = Number(lead.id)
  let phone = null
  let contactId = null
  for (const c of lead._embedded?.contacts || []) {
    const p = extractContactPhone(byId.get(Number(c.id)))
    if (p) {
      phone = p
      contactId = Number(c.id)
      break
    }
  }
  if (!phone) {
    skipped.push({ lid, reason: 'no_phone', statusId: lead._statusId })
    continue
  }

  const row = await fetchDadosClienteByTelefone(env, phone, 'atendimento_ia,inscricao_form_status')
  if (String(row?.atendimento_ia || '').toLowerCase() === 'pause') {
    skipped.push({ lid, reason: 'ia_pause', statusId: lead._statusId })
    continue
  }
  const formSt = String(row?.inscricao_form_status || '').trim()
  if (formSt && SKIP_FORM.has(formSt)) {
    skipped.push({ lid, reason: `form_${formSt}`, statusId: lead._statusId })
    continue
  }

  const buf = await bufferCount(env, phone)
  const hist = await fetchRecentChatRows(env, phone, 20)
  const { needsReply: histNeeds } = analyzeHistory(hist)
  const noteCheck = await noteNeedsReply(env, lid)
  const needs =
    buf.count > 0 || histNeeds || noteCheck.needs

  const item = {
    lid,
    phone,
    contactId,
    statusId: lead._statusId,
    name: String(lead.name || '').slice(0, 40),
    buffer: buf.count,
    sessionId: buf.sessionId,
    histNeeds,
    noteReason: noteCheck.reason,
    notePreview: noteCheck.preview || null,
  }

  if (needs) candidates.push(item)
  else skipped.push({ ...item, reason: 'idle' })
}

if (!fromOutage && limit > 0) candidates.splice(limit)

console.log(
  `mode=${dryRun ? 'DRY-RUN' : 'APPLY'} fromOutage=${fromOutage} filter=${statusFilter} scanned=${leads.length} candidates=${fromOutage ? leads.length : candidates.length} skipped=${skipped.length}`,
)

for (const c of candidates) {
  console.log(
    `[candidate] lead=${c.lid} status=${c.statusId} buf=${c.buffer} hist=${c.histNeeds} note=${c.noteReason} ${c.notePreview || ''}`,
  )
}

const work = fromOutage
  ? (
      await Promise.all(
        leads.map(async (lead) => {
          const lid = Number(lead.id)
          let phone = null
          let contactId = null
          for (const c of lead._embedded?.contacts || []) {
            const p = extractContactPhone(byId.get(Number(c.id)))
            if (p) {
              phone = p
              contactId = Number(c.id)
              break
            }
          }
          if (!phone) return null
          const row = await fetchDadosClienteByTelefone(env, phone, 'atendimento_ia,inscricao_form_status')
          if (String(row?.atendimento_ia || '').toLowerCase() === 'pause') return null
          const formSt = String(row?.inscricao_form_status || '').trim()
          if (formSt && SKIP_FORM.has(formSt)) return null
          const buf = await bufferCount(env, phone)
          return {
            lid,
            phone,
            contactId,
            statusId: lead._statusId,
            sessionId: buf.sessionId,
            outageSeed: lead._outageSeed || null,
          }
        }),
      )
    ).filter(Boolean)
  : candidates

for (const w of work) {
  if (fromOutage) {
    console.log(`[outage] lead=${w.lid} status=${w.statusId} seed=${String(w.outageSeed || '').slice(0, 60)}`)
  }
}

const stats = { moved: 0, synced: 0, seeded: 0, flushed: 0, errors: 0, skipped: 0 }

for (const c of work) {
  if (c.statusId === STATUS_INSCRICAO) {
    console.log(`[skip] lead=${c.lid} em inscrição — não força flush automático`)
    stats.skipped++
    continue
  }

  if (c.statusId === STATUS_AGUARDANDO) {
    console.log(`[move] lead=${c.lid} Aguardando_resposta → Atendimento`)
    if (!dryRun) {
      const mv = await updateLeadPipelineStatus(env, c.lid, {
        pipelineId: PIPE,
        statusId: STATUS_ATENDIMENTO,
      })
      if (!mv.ok) {
        console.warn(`  move falhou: ${mv.error}`)
        stats.errors++
        continue
      }
      stats.moved++
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  resetKommoInboundPollStateForLead(c.lid)
  if (!dryRun) {
    const syncRes = await syncKommoInboundToBuffer(env, {
      leadId: c.lid,
      sessionId: c.sessionId,
      phone: c.phone,
      contactId: c.contactId > 0 ? c.contactId : null,
    })
    stats.synced++
    let msgs = await getMessages(env, c.sessionId)
    if (!msgs?.length) {
      const hist = await fetchRecentChatRows(env, c.phone, 20)
      const { lastUser, needsReply } = analyzeHistory(hist)
      const seed = (needsReply && lastUser) || c.outageSeed || null
      if (seed) {
        await pushMessage(env, c.sessionId, seed, { skipDedupe: true })
        stats.seeded++
        msgs = await getMessages(env, c.sessionId)
      }
    }
    if (!msgs?.length) {
      console.log(`[skip-flush] lead=${c.lid} sem buffer após sync`)
      continue
    }
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS))
    const out = await flushSession(env, c.sessionId, { leadIdHint: c.lid })
    console.log(
      `  flush lead=${c.lid} ok=${out?.ok} skipped=${out?.skipped || 'n/a'} reply=${String(out?.reply || '').slice(0, 100)}`,
    )
    if (out?.ok) stats.flushed++
    else stats.errors++
    await new Promise((r) => setTimeout(r, INTER_LEAD_MS))
  }
}

console.log('\n--- resumo ---')
console.log(JSON.stringify(stats, null, 2))
