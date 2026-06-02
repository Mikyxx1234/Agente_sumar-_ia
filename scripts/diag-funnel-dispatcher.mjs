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
const PIPELINE = 13756724
const STATUSES = [106140284, 106804680]
const PROBE = 'https://banco-agente-sumare.6tqx2r.easypanel.host/api/kommo-dispatcher/probe'

const params = new URLSearchParams()
params.set('limit', '50')
params.set('filter[pipeline_id]', String(PIPELINE))
STATUSES.forEach((s, i) => params.set(`filter[statuses][${i}][pipeline_id]`, String(PIPELINE)) || params.set(`filter[statuses][${i}][status_id]`, String(s)))
params.set('order[updated_at]', 'desc')

const res = await fetch(`${base}/api/v4/leads?${params.toString()}`, {
  headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
})
const data = await res.json()
const leads = data?._embedded?.leads || []
console.log(`leads no funil (pipeline ${PIPELINE}, status ${STATUSES.join('/')}):`, leads.length)

for (const l of leads.slice(0, 12)) {
  const r = await fetch(`${PROBE}?path=/api/kommo/messages/by-lead/${l.id}%26limit=5%26order=desc`)
  let n = '?'
  try {
    const j = await r.json()
    n = Array.isArray(j.json) ? j.json.length : (j.json ? 'obj' : 'vazio')
  } catch { n = 'erro' }
  const upd = new Date(l.updated_at * 1000).toISOString().slice(0, 16)
  console.log(`  lead ${l.id} status=${l.status_id} updated=${upd} -> dispatcher msgs=${n}`)
}
