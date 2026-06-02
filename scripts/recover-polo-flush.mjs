/**
 * Recupera turno perdido (ex.: polo "2") — empurra no buffer e flush com envio WhatsApp.
 * Uso: node scripts/recover-polo-flush.mjs [telefone] [leadId] [mensagem]
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pushMessage } from '../server/evolution/messageBuffer.js'
import { flushSession } from '../server/evolution/webhookEvolution.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

function loadEnv() {
  const env = { ...process.env }
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return env
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!k || env[k]) continue
    env[k] = line.slice(i + 1)
  }
  return env
}

const env = loadEnv()
const phone = String(process.argv[2] || '5511944690752').replace(/[^0-9]/g, '')
const leadId = Number(process.argv[3] || 23841399)
const message = String(process.argv[4] || '2').trim()
const sessionId = phoneToWhatsAppSessionId(phone)

console.log(`Recover flush session=${sessionId} lead=${leadId} msg="${message}"`)

const push = await pushMessage(env, sessionId, message, { skipDedupe: true })
console.log('push:', push)

const out = await flushSession(env, sessionId, { leadIdHint: leadId })
console.log('flush ok:', out?.ok, 'reply:', out?.reply?.slice(0, 120))
if (!out?.ok) {
  console.error('flush error:', out?.error || out)
  process.exit(1)
}
