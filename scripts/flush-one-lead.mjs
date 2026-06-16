import fs from 'node:fs'
import { flushSession } from '../server/evolution/webhookEvolution.js'
import { whatsAppSessionVariants } from '../server/phoneWhatsApp.js'
import { getMessages } from '../server/evolution/messageBuffer.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const leadId = Number(process.argv[2])
const phone = String(process.argv[3] || '')

// escolhe a variante de sessão com mais mensagens
let best = null
let bestN = -1
for (const sid of whatsAppSessionVariants(phone)) {
  const m = await getMessages(env, sid)
  const n = Array.isArray(m) ? m.length : 0
  console.log(`  ${sid}: ${n} msgs`)
  if (n > bestN) { bestN = n; best = sid }
}
if (bestN <= 0) { console.log('sem buffer; nada a fazer'); process.exit(0) }

console.log(`flushSession lead=${leadId} session=${best} (${bestN} msgs)...`)
const res = await flushSession(env, best, { leadIdHint: leadId })
console.log('resultado:', JSON.stringify(res)?.slice(0, 500))
