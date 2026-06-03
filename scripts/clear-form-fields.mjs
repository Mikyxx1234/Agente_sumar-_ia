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

const { listLeadCustomFields } = await import('../server/kommoClient.js')

// IDs fixos do formulário (mesmos do n8n) + e-mail resolvido por alias.
const ids = { nome: 1475361, cpf: 1475363, data_nasc: 1475467, sexo: 1475971 }
const lookup = await listLeadCustomFields(env).catch(() => ({ ok: false }))
let emailId = null
if (lookup.ok && lookup.byName) {
  for (const a of ['sum_email', 'sum e-mail', 'e-mail', 'email']) {
    const def = lookup.byName.get(a)
    if (def?.id) { emailId = Number(def.id); break }
  }
}
if (emailId) ids.email = emailId

const custom_fields_values = Object.entries(ids).map(([, id]) => ({ field_id: id, values: null }))
console.log('limpando campos:', JSON.stringify(ids))

const res = await fetch(`${base}/api/v4/leads/${leadId}`, {
  method: 'PATCH',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ custom_fields_values }),
})
console.log('PATCH status:', res.status)
console.log((await res.text()).slice(0, 300))
