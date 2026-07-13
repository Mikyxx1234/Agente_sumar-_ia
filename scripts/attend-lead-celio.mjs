/**
 * Corrige atendimento — lead #24097691 (Célio): pagamento no dia 30, processo hoje.
 * node --env-file=.env scripts/attend-lead-celio.mjs
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

const LEAD_ID = 24097691
const USER_MSG =
  'Como tinha dito só vou ter um valor dia 30 deste mês daqui a 17 dias..há possibilidade de fazer todo o processo hj pra garantir a vaga..e pagar este valor promocional dia 30..e a liberação do curso não tem problema se iniciar tbm no dia Q pagar..se puder fazemos o processo hj mesmo..mas se não houver possibilidade daqui a 17 dias te chamo e se houver vaga fechamos'

const summary = await getLeadSummary(env, LEAD_ID)
if (!summary.ok || !summary.phone) {
  console.error('lead sem telefone', summary)
  process.exit(1)
}
const phone = summary.phone.replace(/\D/g, '')
const pushName = (() => {
  const n = String(summary.name || 'Célio').trim()
  if (/^lead\s*#/i.test(n)) return 'Célio'
  return n.split(/\s+/)[0] || 'Célio'
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
  `Oi, ${pushName}! Peço desculpas pela resposta anterior sobre polos — não era o que você perguntou.\n\n` +
  String(out?.reply || '').trim()

if (!body.trim() || /5 polos listados abaixo/i.test(body)) {
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
  'Correção manual: lead perguntou matrícula hoje com pagamento no dia 30; agente respondeu lista de polos por falso positivo.',
).catch(() => {})

console.log('done')
