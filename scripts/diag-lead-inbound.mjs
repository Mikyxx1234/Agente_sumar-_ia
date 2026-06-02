import fs from 'node:fs'
import { listLeadNotes, listLeadEvents } from '../server/kommoClient.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const leadId = Number(process.argv[2] || 23583611)

console.log('=== NOTES (desc) ===')
const notes = await listLeadNotes(env, leadId, { limit: 20, order: 'desc' })
if (!notes.ok) {
  console.log('notes erro:', notes.error || notes.status)
} else {
  for (const n of (notes.notes || []).slice(0, 20)) {
    const p = n.params || {}
    const txt = String(p.text || p.message || '').replace(/\s+/g, ' ').slice(0, 70)
    console.log(`  id=${n.id} type=${n.note_type} created=${n.created_at} text="${txt}"`)
  }
}

console.log('\n=== EVENTS incoming_chat_message (desc) ===')
const ev = await listLeadEvents(env, leadId, { types: ['incoming_chat_message'], fromTs: 0, limit: 30 })
if (!ev.ok) {
  console.log('events erro:', ev.error || ev.status, 'url=', ev.requestUrl)
} else {
  const list = ev.events || []
  console.log('total incoming:', list.length)
  for (const e of list.slice(0, 15)) {
    let preview = ''
    try { preview = JSON.stringify(e.value_after).slice(0, 160) } catch {}
    console.log(`  id=${e.id} created=${e.created_at} value_after=${preview}`)
  }
}
