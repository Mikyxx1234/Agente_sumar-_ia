import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const base = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
const token = env.KOMMO_ACCESS_TOKEN || ''
const leadId = process.argv[2] || '23841399'

const AGENT_PIPELINE = 13756724
const AGENT_STATUS = 106140284

const res = await fetch(`${base}/api/v4/leads/${leadId}`, {
  headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
})
const lead = await res.json()
console.log('lead:', lead.id, '|', lead.name)
console.log('pipeline_id:', lead.pipeline_id, '(funil agente:', AGENT_PIPELINE, lead.pipeline_id === AGENT_PIPELINE ? 'OK' : 'DIFERENTE', ')')
console.log('status_id:', lead.status_id, '(status atendimento:', AGENT_STATUS, lead.status_id === AGENT_STATUS ? 'OK -> agente atende' : 'DIFERENTE -> agente NAO atende', ')')

// nomes das etapas do pipeline
const pres = await fetch(`${base}/api/v4/leads/pipelines/${lead.pipeline_id}`, {
  headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
})
const pipe = await pres.json()
const statuses = pipe?._embedded?.statuses || []
console.log('\nEtapas do pipeline', lead.pipeline_id, '(', pipe.name, '):')
for (const s of statuses) {
  const here = s.id === lead.status_id ? '  <== LEAD AQUI' : ''
  const agent = s.id === AGENT_STATUS ? '  [STATUS DO AGENTE]' : ''
  console.log(`  ${s.id}  ${s.name}${agent}${here}`)
}
