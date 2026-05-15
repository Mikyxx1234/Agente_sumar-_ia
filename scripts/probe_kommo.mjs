const base = process.env.KOMMO_BASE_URL?.replace(/\/$/, '')
const token = process.env.KOMMO_ACCESS_TOKEN
const H = { Authorization: `Bearer ${token}` }
const leadId = 23751075

const r = await fetch(`${base}/api/v4/leads/${leadId}/notes?order[id]=desc&limit=5`, { headers: H })
const body = await r.text()
console.log(`HTTP ${r.status}\n${body}`)
