/**
 * Dispara saudação proativa para leads na fila Atendimento sem nenhum atendimento prévio.
 *
 * Uso:
 *   node scripts/proactive-greet-queue.mjs --dry-run
 *   node scripts/proactive-greet-queue.mjs --apply
 *   node scripts/proactive-greet-queue.mjs --apply --delay-ms 2500
 */
import fs from 'node:fs'
import { listLeadsInAgentQueue } from '../server/kommoAgentFunnel.js'
import { bulkGetContactsByIds, extractContactPhone, listLeadNotes } from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'
import { getMessages } from '../server/evolution/messageBuffer.js'
import { fetchRecentChatRows, saveConversation, appendChatMemory } from '../server/historyStore.js'
import { fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'
import { sendMessageWithNote } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'
import { runBuscarHistorico } from '../server/memoryTool.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'

const GREETING =
  'Olá! Sou o assistente da Faculdade Sumaré e posso te ajudar com cursos, valores, matrícula e informações sobre nossos programas. Você já tem algum curso em mente ou quer conhecer as opções?'

const AGENT_NOTE_RE =
  /assistente|faculdade sumaré|sou o assistente|sou assistente|encaminhei seu atendimento|já encaminhei|bem-vindo|bem vindo|\s-\sEX-\d{6}/i

const SKIP_FORM = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
])

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const args = process.argv.slice(2)
const dryRun = !args.includes('--apply')
const delayMs = Number(args.find((a, i) => args[i - 1] === '--delay-ms') || 2200)

async function hasPriorAttendance(phone, leadId) {
  const sid = phoneToWhatsAppSessionId(phone)
  const buf = await getMessages(env, sid)
  if (buf?.length) return { attended: true, reason: 'buffer_pending' }

  const mem = await runBuscarHistorico(env, { telefone: phone, limit: 8 })
  if (mem.ok && (mem.mensagens || []).some((m) => m.role === 'assistente')) {
    return { attended: true, reason: 'n8n_memory' }
  }

  const rows = await fetchRecentChatRows(env, phone, 12)
  if (rows.some((r) => String(r?.bot_message || '').trim())) {
    return { attended: true, reason: 'chat_messages' }
  }

  const notes = await listLeadNotes(env, leadId, { limit: 20 })
  for (const n of notes.notes || []) {
    const t = String(n.params?.text || '').trim()
    if (AGENT_NOTE_RE.test(t)) return { attended: true, reason: 'kommo_note' }
  }

  return { attended: false }
}

const listing = await listLeadsInAgentQueue(env)
if (!listing.ok) {
  console.error('falha listar fila:', listing.error)
  process.exit(1)
}

const leads = listing.leads || []
const contactIds = []
for (const l of leads) for (const c of l._embedded?.contacts || []) contactIds.push(Number(c.id))
const bulk = await bulkGetContactsByIds(env, [...new Set(contactIds)])
const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))

const stats = { sent: 0, skip: 0, fail: 0, targets: 0 }

for (const lead of leads) {
  const lid = Number(lead.id)
  let phone = null
  for (const c of lead._embedded?.contacts || []) {
    const p = extractContactPhone(byId.get(Number(c.id)))
    if (p) {
      phone = p
      break
    }
  }
  if (!phone) {
    stats.skip++
    continue
  }

  const row = await fetchDadosClienteByTelefone(env, phone, 'atendimento_ia,inscricao_form_status')
  if (String(row?.atendimento_ia || '').toLowerCase() === 'pause') {
    console.log(`[skip] lead=${lid} ia_paused`)
    stats.skip++
    continue
  }
  const formSt = String(row?.inscricao_form_status || '').trim()
  if (formSt && SKIP_FORM.has(formSt)) {
    console.log(`[skip] lead=${lid} form=${formSt}`)
    stats.skip++
    continue
  }

  const check = await hasPriorAttendance(phone, lid)
  if (check.attended) {
    stats.skip++
    continue
  }

  stats.targets++
  const name = String(lead.name || '').slice(0, 28)
  console.log(`[${dryRun ? 'would-send' : 'send'}] lead=${lid} ${name} phone=${phone}`)

  if (dryRun) continue

  const executionId = generateExecutionId()
  const sendRes = await sendMessageWithNote(env, {
    telefone: phone,
    text: GREETING,
    leadId: lid,
    executionId,
  })

  if (!sendRes?.ok || sendRes.deduped) {
    console.log(`  FALHA ok=${sendRes?.ok} deduped=${sendRes?.deduped} err=${sendRes?.error || sendRes?.reason || 'n/a'}`)
    stats.fail++
    await new Promise((r) => setTimeout(r, delayMs))
    continue
  }

  await appendChatMemory(env, { telefone: phone, userMessage: '', botMessage: GREETING }).catch(() => {})
  await saveConversation(env, {
    telefone: phone,
    userMessage: '',
    botMessage: GREETING,
    messageType: 'proactive_greet',
    idLead: lid,
  }).catch(() => {})

  console.log(`  OK exec=${executionId}`)
  stats.sent++
  await new Promise((r) => setTimeout(r, delayMs))
}

console.log('\n--- resumo ---')
console.log(`mode=${dryRun ? 'DRY-RUN' : 'APPLY'} total_fila=${leads.length}`)
console.log(JSON.stringify(stats, null, 2))
