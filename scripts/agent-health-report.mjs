/**
 * Relatório diário de saúde do agente.
 * Uso: node --env-file=.env scripts/agent-health-report.mjs [--date YYYY-MM-DD]
 */
import fs from 'node:fs'
import { listLeadsByStatus, listLeadNotes } from '../server/kommoClient.js'
import { AGENT_FUNNEL_PIPELINE_ID, AGENT_FUNNEL_STATUS_ID } from '../server/kommoAgentFunnelGate.js'

const env = { ...process.env }
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    env[line.slice(0, i).trim()] ||= line.slice(i + 1)
  }
}

const args = process.argv.slice(2)
const dateArg = args.find((a, i) => args[i - 1] === '--date') || new Date().toISOString().slice(0, 10)
const BASE = (env.PROD_BASE_URL || 'https://banco-agente-sumare.6tqx2r.easypanel.host').replace(/\/$/, '')

const AGENT_EX = /\s-\sEX-\d{6}-\d{4}-\d{3}(-[a-f0-9]+)?\s*$/i
const PDF_GRADE = /\[PDF grade curricular\]/i
const PIPE = AGENT_FUNNEL_PIPELINE_ID
const STATUSES = [AGENT_FUNNEL_STATUS_ID, 106804680, 106377088]

function noteDay(tsSec) {
  const d = new Date(Number(tsSec) * 1000)
  return d.toISOString().slice(0, 10)
}

async function listLeads() {
  const out = []
  for (const statusId of STATUSES) {
    for (let page = 1; page <= 10; page++) {
      const r = await listLeadsByStatus(env, { pipelineId: PIPE, statusId, page, limit: 250 })
      if (!r.ok) break
      out.push(...(r.leads || []))
      if ((r.leads || []).length < 250) break
    }
  }
  const byId = new Map()
  for (const l of out) byId.set(Number(l.id), l)
  return [...byId.values()].slice(0, 200)
}

const funnel = await fetch(`${BASE}/api/scheduler/funnel`, { signal: AbortSignal.timeout(60000) })
  .then((r) => r.json())
  .catch(() => ({ ok: false }))

const leads = await listLeads()
const multiEx = []
const multiPdf = []

for (const lead of leads) {
  const lid = Number(lead.id)
  const notesRes = await listLeadNotes(env, lid, { limit: 30 })
  if (!notesRes.ok) continue
  const exIds = new Set()
  let pdfCount = 0
  for (const n of notesRes.notes || []) {
    const raw = String(n?.params?.text || '').trim()
    if (!raw) continue
    const day = noteDay(n.created_at)
    if (day !== dateArg) continue
    if (AGENT_EX.test(raw)) {
      const m = raw.match(/EX-\d{6}-\d{4}-\d{3}(?:-[a-f0-9]+)?/i)
      if (m) exIds.add(m[0].toUpperCase())
    }
    if (PDF_GRADE.test(raw)) pdfCount++
  }
  if (exIds.size >= 3) {
    multiEx.push({ leadId: lid, name: lead.name, count: exIds.size })
  }
  if (pdfCount >= 2) {
    multiPdf.push({ leadId: lid, name: lead.name, pdfCount })
  }
}

const report = {
  at: new Date().toISOString(),
  date: dateArg,
  funnel: {
    ok: funnel?.ok ?? false,
    queueSize: funnel?.leads?.length ?? 0,
    queueBuffer: (funnel?.leads || []).filter((l) => (l.bufferCount || 0) > 0).length,
    orphansBuffer: (funnel?.orphans || []).filter((o) => (o.bufferCount || 0) > 0).length,
  },
  config: {
    inboundPollMode: env.KOMMO_INBOUND_POLL_MODE || 'notes',
    gradePdfAutoEnabled: String(env.GRADE_PDF_AUTO_ENABLED ?? 'true'),
  },
  scannedLeads: leads.length,
  leadsMultiEx3Plus: multiEx.length,
  leadsMultiPdf2Plus: multiPdf.length,
  topMultiEx: multiEx.sort((a, b) => b.count - a.count).slice(0, 15),
  topMultiPdf: multiPdf.sort((a, b) => b.pdfCount - a.pdfCount).slice(0, 15),
}

const outPath = `scripts/_agent-health-${dateArg}.json`
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))

console.log(`=== Agent health ${dateArg} ===`)
console.log(`Fila: ${report.funnel.queueSize} leads | buffer fila: ${report.funnel.queueBuffer} | órfãos buffer: ${report.funnel.orphansBuffer}`)
console.log(`Inbound poll: ${report.config.inboundPollMode} | GRADE_PDF_AUTO: ${report.config.gradePdfAutoEnabled}`)
console.log(`Leads 3+ EX-/dia: ${report.leadsMultiEx3Plus} | Leads 2+ PDF grade/dia: ${report.leadsMultiPdf2Plus}`)
if (report.topMultiEx.length) {
  console.log('\nTop EX- spam:')
  for (const r of report.topMultiEx) console.log(`  #${r.leadId} ${String(r.name || '').slice(0, 30)} ex=${r.count}`)
}
if (report.topMultiPdf.length) {
  console.log('\nTop PDF grade spam:')
  for (const r of report.topMultiPdf) console.log(`  #${r.leadId} ${String(r.name || '').slice(0, 30)} pdfs=${r.pdfCount}`)
}
console.log(`\nJSON: ${outPath}`)
