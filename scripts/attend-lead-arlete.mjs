/**
 * Corrige atendimento — lead #24087993 (Arlete): pergunta Vila Prudente/zona leste.
 * node --env-file=.env scripts/attend-lead-arlete.mjs
 */
import fs from 'node:fs'
import { getLeadSummary, createLeadAuditNote } from '../server/kommoClient.js'
import { sendMessageWithNote, sendText } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'
import { ensureDadosClienteRow } from '../server/dadosClienteStore.js'
import { buildPoloEadAndCentralInfoReply } from '../libShared/sumarePoloCatalog.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  env[line.slice(0, i).trim()] ||= line.slice(i + 1)
}

const LEAD_ID = 24087993

const summary = await getLeadSummary(env, LEAD_ID)
if (!summary.ok || !summary.phone) {
  console.error('lead sem telefone', summary)
  process.exit(1)
}
const phone = summary.phone.replace(/\D/g, '')
const pushName = (() => {
  const n = String(summary.name || 'Arlete').trim()
  if (/^lead\s*#/i.test(n)) return 'Arlete'
  return n.split(/\s+/)[0] || 'Arlete'
})()

console.log('lead', LEAD_ID, 'phone', phone, 'name', summary.name)

await ensureDadosClienteRow(env, {
  telefone: phone,
  idLead: LEAD_ID,
  fields: { id_lead: LEAD_ID, teste_ab: 'IA', atendimento_ia: null, inscricao_form_status: null },
})

const executionId = generateExecutionId()
const apology =
  `Oi, ${pushName}! Peço desculpas pela resposta anterior — sua pergunta sobre localização *está sim* no nosso atendimento.\n\n`
const body = apology + buildPoloEadAndCentralInfoReply({ pushName })

console.log('--- enviando ---')
console.log(body.slice(0, 700))

let sendRes = await sendMessageWithNote(env, {
  telefone: phone,
  text: body,
  leadId: LEAD_ID,
  executionId: `${executionId}-fix`,
})

if (!sendRes?.ok || /dedupe|similar|held/i.test(String(sendRes?.error || ''))) {
  sendRes = await sendText(env, { to: phone, text: `${body}\n\n - ${executionId}-fix` })
}

console.log('whatsapp', sendRes?.ok ? 'ok' : sendRes?.error)

await createLeadAuditNote(
  env,
  LEAD_ID,
  'Correção manual: lead perguntou Vila Prudente/zona leste — resposta canônica com 5 polos EAD + Central Pinheiros (semipresencial/presencial).',
).catch(() => {})

console.log('done')
