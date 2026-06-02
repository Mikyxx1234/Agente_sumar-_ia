import fs from 'node:fs'
import { extractContactPhone, extractLeadPhone, bulkGetContactsByIds } from '../server/kommoClient.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const base = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
const token = env.KOMMO_ACCESS_TOKEN || ''
const leadId = Number(process.argv[2] || 23583611)

const res = await fetch(`${base}/api/v4/leads/${leadId}?with=contacts`, {
  headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
})
const lead = await res.json()
console.log('lead:', lead.id, '|', lead.name)
const contacts = lead?._embedded?.contacts || []
console.log('contatos embedded:', contacts.map((c) => ({ id: c.id, is_main: c.is_main })))

const leadPhone = extractLeadPhone(lead)
console.log('extractLeadPhone:', leadPhone || '(nenhum)')

const ids = contacts.map((c) => Number(c.id)).filter(Boolean)
if (ids.length) {
  const bulk = await bulkGetContactsByIds(env, ids)
  if (bulk.ok) {
    for (const c of bulk.contacts) {
      const p = extractContactPhone(c)
      console.log(`contato ${c.id} (${c.name || 's/nome'}): phone=${p || '(nenhum)'}`)
    }
  } else {
    console.log('bulkGetContactsByIds falhou:', bulk.error || bulk.status)
  }
} else {
  console.log('NENHUM contato vinculado ao lead -> sem telefone -> scheduler pula (skippedNoPhone)')
}
