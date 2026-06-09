/**
 * Envia mensagem corretiva manual para um lead específico.
 *
 * Uso:
 *   node scripts/send-corrective-lead.mjs --lead-id 23843695 --dry-run
 *   node scripts/send-corrective-lead.mjs --lead-id 23843695 --apply
 */
import fs from 'node:fs'
import { getLeadSummary } from '../server/kommoClient.js'
import { sendMessageWithNote } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'
import { appendChatMemory, saveConversation } from '../server/historyStore.js'
import { formatPoloListaNumerada } from '../libShared/sumarePoloCatalog.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const args = process.argv.slice(2)
const leadId = Number(args.find((a, i) => args[i - 1] === '--lead-id') || 0)
const dryRun = !args.includes('--apply')

if (!leadId) {
  console.error('Uso: node scripts/send-corrective-lead.mjs --lead-id <id> [--apply]')
  process.exit(1)
}

const summary = await getLeadSummary(env, leadId)
if (!summary.ok || !summary.phone) {
  console.error('Falha ao obter lead:', summary.error || 'telefone ausente')
  process.exit(1)
}

const firstName = String(summary.name || 'Olá').split(/\s+/)[0]
const poloList = formatPoloListaNumerada()

const text =
  `Oi, ${firstName}! Peço desculpas pela resposta anterior — vou esclarecer suas dúvidas:\n\n` +
  `*1. Mensalidade e desconto:* Pagando no *1º dia de cada mês*, o desconto máximo (70%) é aplicado na mensalidade daquele mês. ` +
  `Ou seja, não é só na primeira parcela — mantendo o pagamento no dia 1, o benefício se repete todo mês (ex.: R$ 97, conforme o valor promocional do curso).\n\n` +
  `*2. Taxa de matrícula:* Sim, há taxa de matrícula — ela *é a primeira mensalidade*, no mesmo valor promocional informado (R$ 97).\n\n` +
  `*3. Polos:* Por este número de contato atendemos os seguintes polos:\n\n` +
  `${poloList}\n\n` +
  `Sim, os cursos são *100% EAD*; o polo é o ponto de apoio presencial.\n\n` +
  `Posso te ajudar com mais alguma dúvida ou seguir com a inscrição?`

console.log(`lead=${leadId} name=${summary.name} phone=${summary.phone}`)
console.log(`mode=${dryRun ? 'dry-run' : 'apply'}`)
console.log('---')
console.log(text)
console.log('---')

if (dryRun) process.exit(0)

const executionId = generateExecutionId()
const sendRes = await sendMessageWithNote(env, {
  telefone: summary.phone,
  text,
  leadId,
  executionId,
})

if (!sendRes?.ok || sendRes.deduped) {
  console.error('Falha no envio:', sendRes)
  process.exit(1)
}

await appendChatMemory(env, { telefone: summary.phone, userMessage: '', botMessage: text }).catch(() => {})
await saveConversation(env, {
  telefone: summary.phone,
  userMessage: '',
  botMessage: text,
  messageType: 'corrective_reply',
  idLead: leadId,
}).catch(() => {})

console.log(`OK exec=${executionId}`)
