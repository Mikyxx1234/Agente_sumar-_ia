/**
 * Dispara saudação proativa para leads na fila Atendimento sem nenhum atendimento prévio.
 *
 * Uso:
 *   node scripts/proactive-greet-queue.mjs --dry-run
 *   node scripts/proactive-greet-queue.mjs --apply
 *   node scripts/proactive-greet-queue.mjs --apply --delay-ms 2500
 *   node scripts/proactive-greet-queue.mjs --apply --limit 10   (10 leads mais antigos)
 *
 * Flags:
 *   --apply       envia de verdade (sem isso é dry-run)
 *   --limit N     processa no máximo N leads-alvo (os MAIS ANTIGOS primeiro)
 *   --delay-ms N  intervalo entre envios (default 2200)
 *   --status A,B  lista leads diretamente nesses status do pipeline 13756724
 *                 (ex.: 106377088 = "Aguardando resposta"). Sem isso, usa a
 *                 fila fixa da IA (Atendimento + inscrição).
 *   --move-to S   move cada lead-alvo para o status S (pipeline 13756724) antes
 *                 de saudar — ex.: 106140284 (Atendimento) para que a resposta
 *                 do lead passe a ser atendida pelo agente.
 */
import fs from 'node:fs'
import { listLeadsInAgentQueue } from '../server/kommoAgentFunnel.js'
import {
  bulkGetContactsByIds,
  extractContactPhone,
  listLeadNotes,
  listLeadsByStatus,
  updateLeadPipelineStatus,
} from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'
import { getMessages } from '../server/evolution/messageBuffer.js'
import { fetchRecentChatRows, saveConversation, appendChatMemory } from '../server/historyStore.js'
import { fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'
import { sendMessageWithNote } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'
import { runBuscarHistorico } from '../server/memoryTool.js'
import { buildGreeting } from '../server/proactiveGreet.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'

const SUM_NIVEL_FIELD_ID = Number(process.env.KOMMO_FIELD_SUM_NIVEL_ID) || 1475427

/** Lê sum_Nivel (Graduação/Pós) do objeto lead do Kommo. */
function extractNivel(lead) {
  const fields = lead?.custom_fields_values
  if (!Array.isArray(fields)) return ''
  const f = fields.find((x) => Number(x?.field_id) === SUM_NIVEL_FIELD_ID)
  const v = f?.values?.[0]?.value
  return v ? String(v).trim() : ''
}

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
const limitRaw = Number(args.find((a, i) => args[i - 1] === '--limit'))
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : Infinity
const statusArg = String(args.find((a, i) => args[i - 1] === '--status') || '').trim()
const statusIds = statusArg
  ? statusArg.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
  : null
const PIPELINE_ID = 13756724
const moveToRaw = Number(args.find((a, i) => args[i - 1] === '--move-to'))
const moveToStatus = Number.isFinite(moveToRaw) && moveToRaw > 0 ? Math.floor(moveToRaw) : null

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

let rawLeads = []
if (statusIds) {
  const byId = new Map()
  for (const sid of statusIds) {
    const r = await listLeadsByStatus(env, { pipelineId: PIPELINE_ID, statusId: sid })
    if (!r.ok) {
      console.error(`falha listar status ${sid}:`, r.error)
      continue
    }
    for (const l of r.leads || []) byId.set(Number(l.id), l)
  }
  rawLeads = [...byId.values()]
  console.log(`[fonte] status=[${statusIds.join(',')}] pipeline=${PIPELINE_ID} total=${rawLeads.length}`)
} else {
  const listing = await listLeadsInAgentQueue(env)
  if (!listing.ok) {
    console.error('falha listar fila:', listing.error)
    process.exit(1)
  }
  rawLeads = listing.leads || []
}

// Mais antigos primeiro (created_at do Kommo em segundos).
const leads = rawLeads
  .slice()
  .sort((a, b) => (Number(a?.created_at) || 0) - (Number(b?.created_at) || 0))
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
  const greeting = buildGreeting({ nome: lead.name, nivel: extractNivel(lead) })
  const createdIso = lead.created_at
    ? new Date(Number(lead.created_at) * 1000).toISOString().slice(0, 10)
    : '?'
  const moveLabel = moveToStatus ? ` move->${moveToStatus}` : ''
  console.log(`[${dryRun ? 'would-send' : 'send'}] lead=${lid} ${name} phone=${phone} criado=${createdIso}${moveLabel}`)

  if (!dryRun) {
    if (moveToStatus) {
      const mv = await updateLeadPipelineStatus(env, lid, { pipelineId: PIPELINE_ID, statusId: moveToStatus })
      if (!mv.ok) {
        console.log(`  FALHA mover lead=${lid} status->${moveToStatus}: ${mv.error || mv.code}`)
        stats.fail++
        if (stats.targets >= limit) break
        continue
      }
      console.log(`  movido lead=${lid} -> status ${moveToStatus}`)
    }

    const executionId = generateExecutionId()
    const sendRes = await sendMessageWithNote(env, {
      telefone: phone,
      text: greeting,
      leadId: lid,
      executionId,
    })

    if (!sendRes?.ok || sendRes.deduped) {
      console.log(`  FALHA ok=${sendRes?.ok} deduped=${sendRes?.deduped} err=${sendRes?.error || sendRes?.reason || 'n/a'}`)
      stats.fail++
      await new Promise((r) => setTimeout(r, delayMs))
    } else {
      await appendChatMemory(env, { telefone: phone, userMessage: '', botMessage: greeting }).catch(() => {})
      await saveConversation(env, {
        telefone: phone,
        userMessage: '',
        botMessage: greeting,
        messageType: 'proactive_greet',
        idLead: lid,
      }).catch(() => {})

      console.log(`  OK exec=${executionId}`)
      stats.sent++
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }

  if (stats.targets >= limit) {
    console.log(`[limit] atingido o limite de ${limit} lead(s)-alvo — parando.`)
    break
  }
}

console.log('\n--- resumo ---')
console.log(`mode=${dryRun ? 'DRY-RUN' : 'APPLY'} total_fila=${leads.length}`)
console.log(JSON.stringify(stats, null, 2))
