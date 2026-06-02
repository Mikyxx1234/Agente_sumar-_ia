import fs from 'node:fs'
import { listLeadEvents, tryListTalksForLead, listLeadNotes } from '../server/kommoClient.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const leadId = Number(process.argv[2] || 23583611)

console.log('=== TALK (raw completo) ===')
const t = await tryListTalksForLead(env, leadId)
for (const x of t.talks || []) console.log(JSON.stringify(x, null, 2))

console.log('\n=== EVENTS (TODOS os tipos, desc) ===')
const ev = await listLeadEvents(env, leadId, { types: [], fromTs: 0, limit: 50 })
if (!ev.ok) {
  console.log('events erro:', ev.error || ev.status, 'url=', ev.requestUrl)
} else {
  const list = ev.events || []
  console.log('total:', list.length)
  const byType = {}
  for (const e of list) byType[e.type] = (byType[e.type] || 0) + 1
  console.log('por tipo:', JSON.stringify(byType))
  for (const e of list.slice(0, 20)) {
    console.log(`  id=${e.id} type=${e.type} created=${e.created_at} entity=${e.entity_type}/${e.entity_id}`)
  }
}

console.log('\n=== NOTES (todos os tipos) ===')
const notes = await listLeadNotes(env, leadId, { limit: 30, order: 'desc' })
console.log('notes ok=', notes.ok, 'qtd=', (notes.notes || []).length)
const byNote = {}
for (const n of notes.notes || []) byNote[n.note_type] = (byNote[n.note_type] || 0) + 1
console.log('por note_type:', JSON.stringify(byNote))
