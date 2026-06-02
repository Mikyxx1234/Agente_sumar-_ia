import fs from 'fs'

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const base = String(env.KOMMO_BASE_URL || '').replace(/\/$/, '')
const token = env.KOMMO_ACCESS_TOKEN
const leadId = process.argv[2] || '23841399'
const H = { Authorization: `Bearer ${token}` }

const all = []
for (let page = 1; page <= 6; page += 1) {
  const r = await fetch(`${base}/api/v4/leads/${leadId}/notes?limit=250&page=${page}`, { headers: H })
  if (!r.ok) break
  const j = await r.json()
  const notes = j?._embedded?.notes || []
  all.push(...notes)
  if (notes.length < 250) break
}
all.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
const notes = all.slice(0, 20)
console.log(`notas total=${all.length}, mostrando 20 mais recentes`)
const now = Date.now()
for (const n of notes) {
  const ms = (n.created_at || 0) * 1000
  const ageH = ((now - ms) / 3600000).toFixed(1)
  const txt =
    n.params?.text || n.params?.message || (n.note_type ? `<${n.note_type}>` : '') || JSON.stringify(n.params || {})
  console.log(
    `  ${new Date(ms).toISOString().slice(5, 16)} (${ageH}h) [${n.note_type}] ${String(txt).replace(/\s+/g, ' ').slice(0, 90)}`,
  )
}
