import fs from 'node:fs'
import { tryListTalksForLead, getLeadContactIds, listContactChats } from '../server/kommoClient.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const leadId = Number(process.argv[2] || 23583611)

const t = await tryListTalksForLead(env, leadId)
console.log('talks ok=', t.ok, 'qtd=', (t.talks || []).length)
for (const x of t.talks || []) {
  console.log('  talk:', JSON.stringify({ talk_id: x.talk_id ?? x.id, chat_id: x.chat_id, entity_type: x.entity_type, origin: x.origin, is_in_work: x.is_in_work, is_read: x.is_read }))
}

const cids = await getLeadContactIds(env, leadId)
console.log('\ncontactIds:', cids)
for (const cid of cids) {
  const cc = await listContactChats(env, cid)
  console.log(`contato ${cid} chats ok=${cc.ok}:`, JSON.stringify((cc.chats || []).map((r) => ({ chat_id: r.chat_id }))))
}
