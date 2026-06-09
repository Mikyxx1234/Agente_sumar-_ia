import fs from 'node:fs'
import { listLeadsInAgentQueue } from '../server/kommoAgentFunnel.js'
import { bulkGetContactsByIds, extractContactPhone, listLeadNotes } from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'
import { getMessages } from '../server/evolution/messageBuffer.js'
import { fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const limit = Number(process.argv[2] || 10)
const listing = await listLeadsInAgentQueue(env)
console.log('leads in queue:', listing.leads?.length, 'ok:', listing.ok, 'err:', listing.error || 'none')

const sample = (listing.leads || []).slice(0, limit)
const contactIds = []
for (const l of sample) {
  for (const c of l._embedded?.contacts || []) contactIds.push(Number(c.id))
}
const bulk = await bulkGetContactsByIds(env, [...new Set(contactIds)])
const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))

for (const lead of sample) {
  let phone = null
  for (const c of lead._embedded?.contacts || []) {
    const p = extractContactPhone(byId.get(Number(c.id)))
    if (p) {
      phone = p
      break
    }
  }
  const sid = phone ? phoneToWhatsAppSessionId(phone) : null
  const msgs = sid ? await getMessages(env, sid) : []
  const row = phone ? await fetchDadosClienteByTelefone(env, phone, 'atendimento_ia,inscricao_form_status') : null
  const notes = await listLeadNotes(env, lead.id, { limit: 3 }).catch(() => ({ ok: false, notes: [] }))
  const lastNote = notes.notes?.[0]
  const notePreview = lastNote?.params?.text?.slice(0, 60) || lastNote?.note_type || 'n/a'
  console.log(
    `lead=${lead.id} | ${String(lead.name || '').slice(0, 22).padEnd(22)} | phone=${phone || 'NONE'.padEnd(13)} | buffer=${msgs?.length || 0} | ia=${row?.atendimento_ia ?? 'null'} | form=${row?.inscricao_form_status ?? 'null'} | lastNote=${notePreview}`,
  )
}
