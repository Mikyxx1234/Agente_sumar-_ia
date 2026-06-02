/**
 * Ambiente de teste — injeta inbound de um número específico SEM Evolution.
 *
 * Reusa o caminho real (flushSession) com gates de teste:
 *   - test:true          → ignora ai_disabled / cooldown / ia_paused
 *   - skipFunnelGate:true → não exige o lead no funil da IA
 *   - suppressWhatsapp    → quando --no-send, não envia no WhatsApp (só devolve a reply)
 *
 * Uso:
 *   node scripts/test-inbound.mjs "<mensagem>" [telefone] [leadId] [--no-send]
 *   node scripts/test-inbound.mjs "qual o valor de logistica?" 5511944690752 23841399 --no-send
 *
 * Sem --no-send, o agente responde DE VERDADE no WhatsApp (envio via Evolution).
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pushMessage } from '../server/evolution/messageBuffer.js'
import { flushSession } from '../server/evolution/webhookEvolution.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'
import { findLeadByPhone } from '../server/kommoClient.js'

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
const args = process.argv.slice(2)
const noSend = args.includes('--no-send')
const positional = args.filter((a) => !a.startsWith('--'))
const message = String(positional[0] || 'qual o valor do curso de logística?').trim()
const phone = String(positional[1] || '5511944690752').replace(/[^0-9]/g, '')
let leadId = Number(positional[2] || 0)

const sessionId = phoneToWhatsAppSessionId(phone) || `${phone}@s.whatsapp.net`

console.log(`Teste inbound session=${sessionId} send=${!noSend} msg="${message}"`)

if (!Number.isFinite(leadId) || leadId <= 0) {
  try {
    const lookup = await findLeadByPhone(env, phone)
    if (lookup.ok && lookup.lead) leadId = Number(lookup.lead.id)
  } catch {
    /* segue sem leadId */
  }
}
console.log(`leadId=${leadId || 'n/a'}`)

await pushMessage(env, sessionId, message, { skipDedupe: true, bypassAiSwitch: true })

const out = await flushSession(env, sessionId, {
  leadIdHint: Number.isFinite(leadId) && leadId > 0 ? leadId : undefined,
  test: true,
  skipFunnelGate: true,
  suppressWhatsapp: noSend,
})

console.log('---')
console.log('ok:', out?.ok, 'skipped:', out?.skipped || null)
console.log('reply:', out?.reply || '(sem reply)')
if (out?.toolCalls?.length) {
  console.log('tools:', out.toolCalls.map((t) => `${t.tool}:${t.ok}`).join(', '))
}
if (!out?.ok && !out?.reply) process.exit(1)
