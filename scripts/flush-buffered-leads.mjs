import fs from 'node:fs'
import { listLeadsInAgentQueue } from '../server/kommoAgentFunnel.js'
import { bulkGetContactsByIds, extractContactPhone } from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'
import { getMessages } from '../server/evolution/messageBuffer.js'
import { flushSession } from '../server/evolution/webhookEvolution.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const dryRun = !process.argv.includes('--apply')
const listing = await listLeadsInAgentQueue(env)
const leads = listing.leads || []
const contactIds = []
for (const l of leads) for (const c of l._embedded?.contacts || []) contactIds.push(Number(c.id))
const bulk = await bulkGetContactsByIds(env, [...new Set(contactIds)])
const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))

for (const lead of leads) {
  let phone = null
  for (const c of lead._embedded?.contacts || []) {
    const p = extractContactPhone(byId.get(Number(c.id)))
    if (p) { phone = p; break }
  }
  if (!phone) continue
  const sid = phoneToWhatsAppSessionId(phone)
  const msgs = await getMessages(env, sid)
  if (!msgs?.length) continue
  console.log(`lead=${lead.id} buffer=${msgs.length} msgs=${msgs.map((m) => String(m).slice(0, 30)).join(' | ')}`)
  if (!dryRun) {
    await new Promise((r) => setTimeout(r, 6000))
    const out = await flushSession(env, sid, { leadIdHint: Number(lead.id) })
    console.log(`  flush ok=${out?.ok} reply=${String(out?.reply || '').slice(0, 100)}`)
  }
}
