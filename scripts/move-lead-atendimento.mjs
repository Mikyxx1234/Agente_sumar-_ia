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
const leadId = Number(process.argv[2] || 23841399)
const ATENDIMENTO = 106140284

const res = await fetch(`${base}/api/v4/leads/${leadId}`, {
  method: 'PATCH',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ status_id: ATENDIMENTO }),
})
const body = await res.json().catch(() => null)
console.log('PATCH status:', res.status)
console.log('lead agora status_id:', body?.status_id, body?.status_id === ATENDIMENTO ? 'OK -> Atendimento' : '')
