/**
 * Força processamento do buffer para um lead (scheduler bypass).
 * Uso: node --env-file=.env scripts/manual-flush-lead.mjs <leadId> [mensagem opcional para bufferizar antes]
 */
import fs from 'node:fs'
import { flushSession } from '../server/evolution/webhookEvolution.js'
import { pushMessage } from '../server/evolution/messageBuffer.js'
import { getLeadSummary } from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const leadId = Number(process.argv[2])
const extraMsg = process.argv.slice(3).join(' ').trim()
if (!Number.isFinite(leadId) || leadId <= 0) {
  console.error('Uso: node --env-file=.env scripts/manual-flush-lead.mjs <leadId> [texto]')
  process.exit(1)
}

const summary = await getLeadSummary(env, leadId)
if (!summary.ok || !summary.phone) {
  console.error('Lead sem telefone:', summary)
  process.exit(1)
}

const sessionId = phoneToWhatsAppSessionId(summary.phone)
console.log('lead', leadId, 'phone', summary.phone, 'session', sessionId)

if (extraMsg) {
  await pushMessage(env, sessionId, extraMsg, { skipDedupe: true })
  console.log('buffered:', extraMsg)
  await new Promise((r) => setTimeout(r, 6000))
}

const out = await flushSession(env, sessionId, { leadIdHint: leadId })
console.log(JSON.stringify({
  ok: out?.ok,
  reply: out?.reply?.slice(0, 500),
  error: out?.error,
  iaPaused: out?.iaPaused,
  executionId: out?.executionId,
}, null, 2))
