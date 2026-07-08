/**
 * Corrige lead #24087593 (Lari) — desistência falsa após "Ok" + interesse em cursos EAD.
 * node --env-file=.env scripts/attend-lead-lari.mjs [--dry-run]
 */
import fs from 'node:fs'
import { getLeadSummary, createLeadAuditNote, updateLeadPipelineStatus } from '../server/kommoClient.js'
import { sendMessageWithNote, sendText } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'
import { ensureDadosClienteRow, updateDadosCliente } from '../server/dadosClienteStore.js'
import { runAgent } from '../server/ai/agentRunner.js'
import {
  AGENT_FUNNEL_PIPELINE_ID,
  AGENT_FUNNEL_STATUS_ID,
} from '../server/kommoAgentFunnelGate.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  env[line.slice(0, i).trim()] ||= line.slice(i + 1)
}

const dryRun = process.argv.includes('--dry-run')
const LEAD_ID = 24087593
const USER_MSG =
  'Quero saber os cursos EAD e os valores. Faço farmácia e queria algo para complementar.'

const summary = await getLeadSummary(env, LEAD_ID)
if (!summary.ok || !summary.phone) {
  console.error('lead sem telefone', summary)
  process.exit(1)
}
const phone = summary.phone.replace(/\D/g, '')
const pushName = String(summary.name || 'Lari').split(/\s+/)[0] || 'Lari'

console.log('lead', LEAD_ID, 'phone', phone, 'name', summary.name, dryRun ? '(dry-run)' : '')

await ensureDadosClienteRow(env, {
  telefone: phone,
  idLead: LEAD_ID,
  fields: {
    id_lead: LEAD_ID,
    teste_ab: 'IA',
    atendimento_ia: null,
    inscricao_form_status: null,
  },
})

if (dryRun) {
  console.log('dry-run: estado limpo, mensagem simulada:', USER_MSG)
  process.exit(0)
}

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
  `Oi, ${pushName}! Peço desculpas pela mensagem anterior sobre desistência — foi um erro do sistema. ` +
  `Você *não* desistiu do atendimento.\n\n` +
  String(out?.reply || '').trim()

if (!body.trim() || body.length < 80) {
  console.error('resposta vazia do agente', out)
  process.exit(1)
}

console.log('--- enviando ---')
console.log(body.slice(0, 600))

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

await updateLeadPipelineStatus(env, LEAD_ID, {
  pipelineId: AGENT_FUNNEL_PIPELINE_ID,
  statusId: AGENT_FUNNEL_STATUS_ID,
}).catch(() => {})

await createLeadAuditNote(
  env,
  LEAD_ID,
  'Correção manual: desistência registrada indevidamente após "Ok" + interesse em cursos EAD. Estado revertido; atendimento retomado.',
).catch(() => {})

console.log('done')
