import fs from 'node:fs'
const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) { if (!line||line.startsWith('#')||!line.includes('='))continue; const i=line.indexOf('='); const k=line.slice(0,i).trim(); if(!env[k])env[k]=line.slice(i+1) }

const LEAD = process.argv[2] || '23841399'
const N = Number(process.argv[3] || 12)
const BASE = (env.KOMMO_BASE_URL || env.KOMMO_API_URL || '').replace(/\/$/, '')
const TOKEN = env.KOMMO_ACCESS_TOKEN || env.KOMMO_TOKEN || env.KOMMO_LONG_LIVED_TOKEN
if (!BASE || !TOKEN) { console.error('faltam KOMMO_BASE_URL/KOMMO_ACCESS_TOKEN no .env local'); process.exit(1) }

const r = await fetch(`${BASE}/api/v4/leads/${LEAD}/notes?limit=250`, { headers: { Authorization: `Bearer ${TOKEN}` } })
console.log('HTTP', r.status)
const t = await r.text()
let j; try { j = JSON.parse(t) } catch { console.log(t.slice(0,500)); process.exit(0) }
const all = j?._embedded?.notes || []
const notes = all.sort((a,b)=> (b.created_at-a.created_at) || (b.id-a.id)).slice(0, N).reverse()
console.log(`total=${all.length} | mostrando ${notes.length} mais recentes (antigo→novo)`)
for (const n of notes) {
  const text = n.params?.text || n.params?.service || JSON.stringify(n.params || {}).slice(0,180)
  console.log(`#${n.id} | ${new Date(n.created_at*1000).toISOString()} | type=${n.note_type} | by=${n.created_by} | ${String(text).replace(/\s+/g,' ').slice(0,160)}`)
}
