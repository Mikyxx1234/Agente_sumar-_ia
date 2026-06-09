import fs from 'node:fs'
import { listLeadsInAgentQueue } from '../server/kommoAgentFunnel.js'
import { bulkGetContactsByIds, extractContactPhone, listLeadNotes } from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'
import { getMessages } from '../server/evolution/messageBuffer.js'
import { fetchRecentChatRows } from '../server/historyStore.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const listing = await listLeadsInAgentQueue(env)
const leads = listing.leads || []
const contactIds = []
for (const l of leads) for (const c of l._embedded?.contacts || []) contactIds.push(Number(c.id))
const bulk = await bulkGetContactsByIds(env, [...new Set(contactIds)])
const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))

const buckets = { buffer: 0, hist_pending: 0, agent_only: 0, empty: 0, no_phone: 0 }

for (const lead of leads) {
  let phone = null
  for (const c of lead._embedded?.contacts || []) {
    const p = extractContactPhone(byId.get(Number(c.id)))
    if (p) { phone = p; break }
  }
  if (!phone) { buckets.no_phone++; continue }
  const sid = phoneToWhatsAppSessionId(phone)
  const buf = await getMessages(env, sid)
  if (buf?.length) { buckets.buffer++; continue }

  const hist = await fetchRecentChatRows(env, phone, 15)
  const hasUser = hist.some((r) => String(r?.user_message || '').trim())
  const hasBot = hist.some((r) => String(r?.bot_message || '').trim())
  if (hasUser) { buckets.hist_pending++; continue }

  const notes = await listLeadNotes(env, lead.id, { limit: 5 })
  const noteTexts = (notes.notes || []).map((n) => String(n.params?.text || '').trim()).filter(Boolean)
  const hasAgentNote = noteTexts.some((t) => /assistente|faculdade sumaré|encaminhamento/i.test(t))
  if (hasAgentNote || hasBot) buckets.agent_only++
  else buckets.empty++
}

console.log('total:', leads.length)
console.log(JSON.stringify(buckets, null, 2))
