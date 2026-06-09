/**
 * Ativa leads parados na fila Atendimento: sync inbound Kommo → buffer → flush.
 *
 * Uso:
 *   node scripts/activate-queue-leads.mjs --dry-run [--limit 20]
 *   node scripts/activate-queue-leads.mjs --apply --limit 5
 *   node scripts/activate-queue-leads.mjs --apply --lead-ids 23895929,23870373
 */
import fs from 'node:fs'
import { listLeadsInAgentQueue } from '../server/kommoAgentFunnel.js'
import { bulkGetContactsByIds, extractContactPhone } from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'
import { getMessages, pushMessage } from '../server/evolution/messageBuffer.js'
import { fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'
import { fetchRecentChatRows } from '../server/historyStore.js'
import {
  syncKommoInboundToBuffer,
  resetKommoInboundPollStateForLead,
} from '../server/kommoInboundPoll.js'
import { flushSession } from '../server/evolution/webhookEvolution.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const args = process.argv.slice(2)
const dryRun = !args.includes('--apply')
const limit = Number(args.find((a, i) => args[i - 1] === '--limit') || 0) || 0
const leadIdsArg = args.find((a, i) => args[i - 1] === '--lead-ids')
const filterIds = leadIdsArg
  ? new Set(leadIdsArg.split(',').map((s) => Number(s.trim())).filter((n) => n > 0))
  : null

const SKIP_FORM = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
])

const DEBOUNCE_MS = 6000

function analyzeHistory(rows) {
  const chronological = [...(rows || [])].reverse()
  let lastUser = null
  let lastBot = null
  for (const row of chronological) {
    const u = String(row?.user_message || '').trim()
    const b = String(row?.bot_message || '').trim()
    if (u) lastUser = u
    if (b) lastBot = b
  }
  const pending =
    lastUser &&
    (!lastBot ||
      chronological.findIndex((r) => String(r?.user_message || '').trim() === lastUser) >
        chronological.findIndex((r) => String(r?.bot_message || '').trim() === lastBot))
  return { lastUser, lastBot, needsReply: Boolean(lastUser && (!lastBot || pending)) }
}

const listing = await listLeadsInAgentQueue(env)
if (!listing.ok) {
  console.error('listLeadsInAgentQueue falhou:', listing.error)
  process.exit(1)
}

let leads = listing.leads || []
if (filterIds?.size) leads = leads.filter((l) => filterIds.has(Number(l.id)))
if (limit > 0) leads = leads.slice(0, limit)

console.log(`mode=${dryRun ? 'DRY-RUN' : 'APPLY'} leads=${leads.length} total_queue=${listing.leads?.length}`)

const contactIds = []
for (const l of leads) {
  for (const c of l._embedded?.contacts || []) contactIds.push(Number(c.id))
}
const bulk = await bulkGetContactsByIds(env, [...new Set(contactIds)])
const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))

const stats = { skip: 0, synced: 0, seeded: 0, flushed: 0, errors: 0, idle: 0 }

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
    console.log(`[skip] lead=${lid} sem telefone`)
    stats.skip++
    continue
  }

  const sid = phoneToWhatsAppSessionId(phone)
  const row = await fetchDadosClienteByTelefone(env, phone, 'atendimento_ia,inscricao_form_status')
  if (String(row?.atendimento_ia || '').toLowerCase() === 'pause') {
    console.log(`[skip] lead=${lid} ia=paused`)
    stats.skip++
    continue
  }
  const formSt = String(row?.inscricao_form_status || '').trim()
  if (formSt && SKIP_FORM.has(formSt)) {
    console.log(`[skip] lead=${lid} form=${formSt}`)
    stats.skip++
    continue
  }

  let bufferBefore = await getMessages(env, sid)
  if (bufferBefore?.length > 0) {
    console.log(`[ready] lead=${lid} buffer=${bufferBefore.length} — já tem fila`)
    if (!dryRun) {
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS))
      const out = await flushSession(env, sid, { leadIdHint: lid })
      console.log(`  flush ok=${out?.ok} reply=${String(out?.reply || '').slice(0, 80)}`)
      if (out?.ok) stats.flushed++
      else stats.errors++
    }
    continue
  }

  resetKommoInboundPollStateForLead(lid)
  const syncRes = await syncKommoInboundToBuffer(env, {
    leadId: lid,
    sessionId: sid,
    phone,
    contactId: contactId > 0 ? contactId : null,
  })
  stats.synced++

  let bufferAfter = await getMessages(env, sid)
  let seedSource = null

  if (!bufferAfter?.length) {
    const hist = await fetchRecentChatRows(env, phone, 30)
    const { lastUser, lastBot, needsReply } = analyzeHistory(hist)
    if (needsReply && lastUser) {
      seedSource = `history:${lastUser.slice(0, 40)}`
      if (!dryRun) {
        await pushMessage(env, sid, lastUser, { skipDedupe: true })
        stats.seeded++
      }
      bufferAfter = dryRun ? [lastUser] : await getMessages(env, sid)
    } else if (lastBot && !lastUser) {
      console.log(`[idle] lead=${lid} agente já respondeu, aguardando lead`)
      stats.idle++
      continue
    } else {
      console.log(`[idle] lead=${lid} sem inbound (sync=${syncRes.pushed} hist_user=${lastUser ? 'sim' : 'não'})`)
      stats.idle++
      continue
    }
  }

  console.log(
    `[${dryRun ? 'would-flush' : 'flush'}] lead=${lid} phone=${phone} buffer=${bufferAfter?.length || 0} sync=${syncRes.pushed} seed=${seedSource || 'poll'}`,
  )

  if (!dryRun && bufferAfter?.length > 0) {
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS))
    const out = await flushSession(env, sid, { leadIdHint: lid })
    console.log(`  ok=${out?.ok} reply=${String(out?.reply || '').slice(0, 120)}`)
    if (out?.ok) stats.flushed++
    else stats.errors++
  }
}

console.log('\n--- resumo ---')
console.log(JSON.stringify(stats, null, 2))
