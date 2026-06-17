/**
 * Diagnóstico da fila "Aguardando resposta" (106377088) — leads parados por falha de envio.
 * Uso: node --env-file=.env scripts/probe-aguardando-resposta.mjs [baseUrl]
 */
import { listLeadsByStatus } from '../server/kommoClient.js'

const BASE = (process.argv[2] || 'https://banco-agente-sumare.6tqx2r.easypanel.host').replace(/\/$/, '')
const PIPELINE = 13756724
const STATUS_AGUARDANDO = 106377088
const SAMPLE = Number(process.argv[3] || 15)

async function fetchLeadNotes(leadId) {
  const base = (process.env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = process.env.KOMMO_ACCESS_TOKEN || ''
  const r = await fetch(`${base}/api/v4/leads/${leadId}/notes?limit=8&order=desc`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const data = await r.json().catch(() => ({}))
  return data?._embedded?.notes || []
}

const wa = await fetch(`${BASE}/api/whatsapp/health`).then((r) => r.json()).catch(() => ({}))
console.log('\n=== WhatsApp (produção) ===')
console.log(`configured=${wa.configured} reachable=${wa.reachable}`)
console.log(`token=${wa.accessTokenMasked || 'n/a'}`)
if (wa.error) console.log(`error=${wa.error}`)

const listing = await listLeadsByStatus(process.env, {
  pipelineId: PIPELINE,
  statusId: STATUS_AGUARDANDO,
  limit: 250,
  maxPages: 4,
})
console.log('\n=== Fila Aguardando resposta (106377088) ===')
console.log(`ok=${listing.ok} total=${listing.leads?.length ?? 0}`)
if (!listing.ok) {
  console.log('erro:', listing.error)
  process.exit(1)
}

let authFails = 0
let otherFails = 0
let withEscalationNote = 0

for (const lead of (listing.leads || []).slice(0, SAMPLE)) {
  const id = lead.id
  const items = await fetchLeadNotes(id)
  const esc = items.find((n) => /Encaminhamento automático.*IA não conseguiu responder/i.test(String(n.params?.text || n.text || '')))
  if (esc) {
    withEscalationNote++
    const txt = String(esc.params?.text || esc.text || '').replace(/\s+/g, ' ')
    if (/Authentication Error|OAuthException|code.:190|Application has been deleted/i.test(txt)) authFails++
    else otherFails++
    console.log(`\n#${id} ${lead.name || '(sem nome)'} updated=${lead.updated_at}`)
    console.log(`  ${txt.slice(0, 200)}`)
  } else {
    console.log(`\n#${id} ${lead.name || '(sem nome)'} — sem nota de escalação recente`)
  }
}

console.log('\n=== Amostra ===')
console.log(`analisados=${Math.min(SAMPLE, listing.leads.length)} com_nota_escalacao=${withEscalationNote}`)
console.log(`auth_oauth_190=${authFails} outros_erros=${otherFails}`)
console.log(`total_fila=${listing.leads.length}\n`)
