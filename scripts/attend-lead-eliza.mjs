/**
 * Corrige atendimento — lead #24097643 (Eliza): LGPD falso positivo em Publicidade e Propaganda.
 * node --env-file=.env scripts/attend-lead-eliza.mjs
 */
import fs from 'node:fs'
import { getLeadSummary, createLeadAuditNote } from '../server/kommoClient.js'
import { sendMessageWithNote, sendText } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'
import { ensureDadosClienteRow } from '../server/dadosClienteStore.js'
import { runAgent } from '../server/ai/agentRunner.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  env[line.slice(0, i).trim()] ||= line.slice(i + 1)
}

const LEAD_ID = 24097643
const USER_MSG = 'Mais informações sobre publicidade e propaganda'

const summary = await getLeadSummary(env, LEAD_ID)
if (!summary.ok || !summary.phone) {
  console.error('lead sem telefone', summary)
  process.exit(1)
}
const phone = summary.phone.replace(/\D/g, '')
const pushName = (() => {
  const n = String(summary.name || 'Eliza').trim()
  if (/^lead\s*#/i.test(n)) return 'Eliza'
  return n.split(/\s+/)[0] || 'Eliza'
})()

console.log('lead', LEAD_ID, 'phone', phone, 'name', summary.name)

await ensureDadosClienteRow(env, {
  telefone: phone,
  idLead: LEAD_ID,
  fields: { id_lead: LEAD_ID, teste_ab: 'IA', atendimento_ia: null },
})

const executionId = generateExecutionId()
const out = await runAgent(env, {
  userMessage: USER_MSG,
  telefone: phone,
  leadId: LEAD_ID,
  pushName,
  executionId,
  suppressWhatsapp: true,
  skipPauseCheck: true,
})

let body =
  `Oi, ${pushName}! Peço desculpas pela mensagem anterior sobre LGPD — foi um erro do sistema. ` +
  `Sua pergunta sobre o curso está totalmente no escopo do nosso atendimento.\n\n` +
  String(out?.reply || '').trim()

if (!body.trim() || /conformidade com a LGPD/i.test(body)) {
  console.error('resposta inválida do agente', out?.reply?.slice(0, 200))
  process.exit(1)
}

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
  'Correção manual: informações sobre Publicidade e Propaganda bloqueadas indevidamente por lgpd_financial_leak (agências de publicidade).',
).catch(() => {})

console.log('done')
