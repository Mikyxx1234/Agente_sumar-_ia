/**
 * Lista leads com 2+ notas de outbound do agente (sufixo EX-) no mesmo dia.
 *
 *   node --env-file=.env scripts/audit-duplicate-ex-notes.mjs
 *   node --env-file=.env scripts/audit-duplicate-ex-notes.mjs --date 2026-06-17
 *   node --env-file=.env scripts/audit-duplicate-ex-notes.mjs --min 2 --limit 200
 */
import fs from 'node:fs'
import { listLeadsByStatus, listLeadNotes } from '../server/kommoClient.js'
import { AGENT_FUNNEL_PIPELINE_ID, AGENT_FUNNEL_STATUS_ID } from '../server/kommoAgentFunnelGate.js'

const env = { ...process.env }
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!env[k]) env[k] = line.slice(i + 1)
  }
}

const args = process.argv.slice(2)
const dateArg = args.find((a, i) => args[i - 1] === '--date') || null
const minDup = Number(args.find((a, i) => args[i - 1] === '--min') || 2) || 2
const scanLimit = Number(args.find((a, i) => args[i - 1] === '--limit') || 300) || 300

const AGENT_EX_NOTE = /\s-\sEX-\d{6}-\d{4}-\d{3}(-[a-f0-9]+)?\s*$/i
const PIPE = AGENT_FUNNEL_PIPELINE_ID
const STATUS_IDS = [
  AGENT_FUNNEL_STATUS_ID,
  106804680,
  106377088,
]

function noteDay(tsSec, tzDate) {
  const d = new Date(Number(tsSec) * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const iso = `${y}-${m}-${day}`
  return tzDate && tzDate !== iso ? null : iso
}

function extractExecId(text) {
  const m = String(text || '').match(/EX-\d{6}-\d{4}-\d{3}(?:-[a-f0-9]+)?/i)
  return m ? m[0].toUpperCase() : null
}

async function listAllLeads() {
  const out = []
  for (const statusId of STATUS_IDS) {
    for (let page = 1; page <= 15; page++) {
      const listing = await listLeadsByStatus(env, { pipelineId: PIPE, statusId, page, limit: 250 })
      if (!listing.ok) break
      out.push(...(listing.leads || []))
      if ((listing.leads || []).length < 250) break
    }
  }
  const byId = new Map()
  for (const l of out) byId.set(Number(l.id), l)
  return [...byId.values()].slice(0, scanLimit)
}

const leads = await listAllLeads()
console.log(`scanning ${leads.length} leads (pipeline ${PIPE}) minDup=${minDup} date=${dateArg || 'any'}`)

const flagged = []
let scanned = 0

for (const lead of leads) {
  const lid = Number(lead.id)
  scanned++
  const notesRes = await listLeadNotes(env, lid, { limit: 30 })
  if (!notesRes.ok) continue
  const byDay = new Map()
  for (const n of notesRes.notes || []) {
    const raw = String(n?.params?.text || n?.params?.message || '').trim()
    if (!raw || !AGENT_EX_NOTE.test(raw)) continue
    const day = noteDay(n?.created_at, dateArg)
    if (!day) continue
    const bucket = byDay.get(day) || []
    bucket.push({
      at: Number(n.created_at) * 1000,
      execId: extractExecId(raw),
      preview: raw.replace(AGENT_EX_NOTE, '').slice(0, 72),
    })
    byDay.set(day, bucket)
  }
  for (const [day, items] of byDay) {
    const uniqueExec = new Set(items.map((x) => x.execId).filter(Boolean))
    if (uniqueExec.size >= minDup) {
      flagged.push({
        leadId: lid,
        name: String(lead.name || '').slice(0, 50),
        statusId: lead.status_id,
        day,
        count: uniqueExec.size,
        execIds: [...uniqueExec],
        preview: items[0]?.preview || '',
      })
    }
  }
}

flagged.sort((a, b) => b.count - a.count || a.leadId - b.leadId)

console.log(`\n=== ${flagged.length} leads com ${minDup}+ respostas EX- no mesmo dia ===\n`)
for (const row of flagged) {
  console.log(
    `#${row.leadId} ${row.name} status=${row.statusId} day=${row.day} ex_count=${row.count}`,
  )
  console.log(`  exec: ${row.execIds.join(', ')}`)
  console.log(`  preview: ${row.preview}…`)
}

const outPath = `scripts/_audit-duplicate-ex-${dateArg || 'all'}.json`
fs.writeFileSync(outPath, JSON.stringify({ scanned, flagged, at: new Date().toISOString() }, null, 2))
console.log(`\nJSON: ${outPath}`)
