/**
 * Ativa leads em Aguardando resposta (106377088) que enviaram mensagem
 * e o agente não respondeu → move para Atendimento (106140284) + flush.
 *
 *   node scripts/activate-aguardando-pending.mjs --dry-run
 *   node scripts/activate-aguardando-pending.mjs --apply [--limit N]
 */
import fs from 'node:fs'
import {
  listLeadsByStatus,
  bulkGetContactsByIds,
  extractContactPhone,
  updateLeadPipelineStatus,
  listLeadNotes,
} from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId, whatsAppSessionVariants } from '../server/phoneWhatsApp.js'
import { getMessages, pushMessage } from '../server/evolution/messageBuffer.js'
import { fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'
import { fetchRecentChatRows } from '../server/historyStore.js'
import { syncKommoInboundToBuffer, resetKommoInboundPollStateForLead } from '../server/kommoInboundPoll.js'
import {
  isKommoSystemOrIntegrationNote,
  isLikelyAgentEcho,
  sanitizeLeadInboundMessage,
} from '../libShared/inboundMessageSanitize.js'
import { flushSession } from '../server/evolution/webhookEvolution.js'
import { AGENT_FUNNEL_PIPELINE_ID, AGENT_FUNNEL_STATUS_ID } from '../server/kommoAgentFunnelGate.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'

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
const limit = Number(args.find((a, i) => args[i - 1] === '--limit') || 0) || 0

const PIPE = AGENT_FUNNEL_PIPELINE_ID
const STATUS_ATENDIMENTO = AGENT_FUNNEL_STATUS_ID
const STATUS_AGUARDANDO = 106377088

const SKIP_FORM = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
])

const DEBOUNCE_MS = 6000
const INTER_LEAD_MS = 4000

function analyzeHistory(rows) {
  const chronological = [...(rows || [])].reverse()
  let lastUser = null
  let lastBot = null
  let lastUserAt = null
  let lastBotAt = null
  let userCount = 0
  for (const row of chronological) {
    const u = String(row?.user_message || '').trim()
    const b = String(row?.bot_message || '').trim()
    if (u) {
      lastUser = u
      lastUserAt = row.created_at
      userCount++
    }
    if (b) {
      lastBot = b
      lastBotAt = row.created_at
    }
  }
  const pending =
    Boolean(lastUser) &&
    (!lastBot || (lastUserAt && lastBotAt && lastUserAt > lastBotAt))
  return { lastUser, lastBot, pending, userCount }
}

function noteText(n) {
  return String(n?.params?.text || n?.params?.message || '').trim()
}

function isOutboundNoteType(t) {
  const x = String(t || '').toLowerCase()
  return x === 'sms_out' || x === 'outgoing_chat_message' || x === 'amomail_message'
}

function classifyInboundNote(n) {
  const raw = noteText(n)
  if (!raw) return null
  if (isOutboundNoteType(n.note_type)) return null
  if (isLikelyAgentEcho(raw) || isKommoSystemOrIntegrationNote(raw)) return null
  if (/\s-\sEX-\d{6}/i.test(raw)) return null
  const clean = sanitizeLeadInboundMessage(raw)
  return clean || null
}

async function bufferInfo(phone) {
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

async function listAllAguardando() {
  const out = []
  for (let page = 1; page <= 20; page++) {
    const listing = await listLeadsByStatus(env, {
      pipelineId: PIPE,
      statusId: STATUS_AGUARDANDO,
      page,
      limit: 250,
    })
    if (!listing.ok) break
    out.push(...(listing.leads || []))
    if ((listing.leads || []).length < 250) break
  }
  return out
}

const leads = await listAllAguardando()
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
    skipped.push({ lid, reason: 'no_phone' })
    continue
  }

  const row = await fetchDadosClienteByTelefone(env, phone, 'atendimento_ia,inscricao_form_status')
  if (String(row?.atendimento_ia || '').toLowerCase() === 'pause') {
    skipped.push({ lid, reason: 'ia_pause' })
    continue
  }
  const formSt = String(row?.inscricao_form_status || '').trim()
  if (formSt && SKIP_FORM.has(formSt)) {
    skipped.push({ lid, reason: `form_${formSt}` })
    continue
  }

  const buf = await bufferInfo(phone)
  const hist = await fetchRecentChatRows(env, phone, 25)
  const { lastUser, pending: histPending, userCount } = analyzeHistory(hist)

  const notesRes = await listLeadNotes(env, lid, { limit: 12 })
  let noteInbound = null
  for (const n of notesRes.notes || []) {
    const t = classifyInboundNote(n)
    if (t) {
      noteInbound = t
      break
    }
  }

  const bufferLooksLikeLead = buf.count > 0 // buffer pendente = lead falou e agente não confirmou envio
  const leadSpoke = bufferLooksLikeLead || userCount > 0 || Boolean(noteInbound)
  const agentDidNotReply =
    bufferLooksLikeLead ||
    histPending ||
    (noteInbound && userCount === 0 && !hist.some((r) => String(r?.bot_message || '').trim()))

  if (leadSpoke && agentDidNotReply) {
    candidates.push({
      lid,
      phone,
      contactId,
      sessionId: buf.sessionId,
      buf: buf.count,
      histPending,
      userCount,
      seed: lastUser || noteInbound || null,
      notePreview: noteInbound?.slice(0, 50) || null,
    })
  } else {
    skipped.push({
      lid,
      reason: leadSpoke ? 'agent_already_replied' : 'no_lead_message',
      buf: buf.count,
      userCount,
    })
  }
}

if (limit > 0) candidates.splice(limit)

console.log(
  `mode=${dryRun ? 'DRY-RUN' : 'APPLY'} aguardando_total=${leads.length} candidates=${candidates.length} skipped=${skipped.length}`,
)
for (const c of candidates) {
  console.log(
    `[pending] lead=${c.lid} buf=${c.buf} users=${c.userCount} histPending=${c.histPending} seed=${String(c.seed || '').slice(0, 55)}`,
  )
}

const stats = { moved: 0, synced: 0, seeded: 0, flushed: 0, sendOk: 0, errors: 0 }

for (const c of candidates) {
  console.log(`[move] lead=${c.lid} → Atendimento`)
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
    await new Promise((r) => setTimeout(r, 400))
  }

  resetKommoInboundPollStateForLead(c.lid)
  if (dryRun) continue

  const syncRes = await syncKommoInboundToBuffer(env, {
    leadId: c.lid,
    sessionId: c.sessionId,
    phone: c.phone,
    contactId: c.contactId > 0 ? c.contactId : null,
  })
  stats.synced++

  let msgs = await getMessages(env, c.sessionId)
  const seedClean = c.seed && !/^\[scheduler\]/i.test(c.seed) ? c.seed : null
  if (!msgs?.length && seedClean) {
    await pushMessage(env, c.sessionId, seedClean, { skipDedupe: true })
    stats.seeded++
    msgs = await getMessages(env, c.sessionId)
  }

  if (!msgs?.length) {
    console.log(`  skip-flush lead=${c.lid} sem buffer após sync (pushed=${syncRes.pushed})`)
    continue
  }

  await new Promise((r) => setTimeout(r, DEBOUNCE_MS))
  const out = await flushSession(env, c.sessionId, { leadIdHint: c.lid })
  const sent = out?.steps?.find?.((s) => s.tool === 'whatsapp.sendMessageWithNote')?.result?.sent > 0
  console.log(
    `  flush ok=${out?.ok} sent=${sent ? 'yes' : 'no'} reply=${String(out?.reply || '').slice(0, 90)}`,
  )
  if (out?.ok) stats.flushed++
  if (sent) stats.sendOk++
  else if (!out?.ok || out?.skipped) stats.errors++
  await new Promise((r) => setTimeout(r, INTER_LEAD_MS))
}

console.log('\n--- resumo ---')
console.log(JSON.stringify(stats, null, 2))
