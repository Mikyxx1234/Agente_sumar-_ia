/**
 * Ativa leads parados na fila Atendimento: sync inbound Kommo → buffer → flush.
 *
 * Uso:
 *   node scripts/activate-queue-leads.mjs --dry-run [--limit 20]
 *   node scripts/activate-queue-leads.mjs --apply --limit 5
 *   node scripts/activate-queue-leads.mjs --apply --lead-ids 23895929,23870373
 *   node scripts/activate-queue-leads.mjs --apply --reativar-ping --status 106140284
 *   node scripts/activate-queue-leads.mjs --apply --reativar-ping --delay-ms 2500
 */
import fs from 'node:fs'
import { listLeadsInAgentQueue } from '../server/kommoAgentFunnel.js'
import {
  AGENT_FUNNEL_PIPELINE_ID,
  AGENT_FUNNEL_STATUS_ID,
} from '../server/kommoAgentFunnelGate.js'
import {
  bulkGetContactsByIds,
  extractContactPhone,
  listLeadsByStatus,
  listLeadNotes,
} from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'
import { getMessages, pushMessage } from '../server/evolution/messageBuffer.js'
import { fetchDadosClienteByTelefone, updateDadosCliente } from '../server/dadosClienteStore.js'
import { fetchRecentChatRows, saveConversation } from '../server/historyStore.js'
import {
  syncKommoInboundToBuffer,
  resetKommoInboundPollStateForLead,
} from '../server/kommoInboundPoll.js'
import { flushSession } from '../server/evolution/webhookEvolution.js'
import { sendMessageWithNote } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'
import { buildGreeting } from '../server/proactiveGreet.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const args = process.argv.slice(2)
const dryRun = !args.includes('--apply')
// --recover-fallback: trata leads cuja última resposta do bot foi a mensagem
// de "instabilidade momentânea" (apagão da OpenAI) como precisando de resposta,
// reenfileirando a pergunta real do lead para o agente responder de verdade.
const recoverFallback = args.includes('--recover-fallback')
// --reativar-ping: agente já respondeu mas o lead pode não ter recebido no WhatsApp
// (ex.: envio simulado sem janela 24h) → manda ping de reativação via Cloud API.
const reativarPing = args.includes('--reativar-ping')
const limit = Number(args.find((a, i) => args[i - 1] === '--limit') || 0) || 0
const delayMs = Number(args.find((a, i) => args[i - 1] === '--delay-ms') || 2200)
const leadIdsArg = args.find((a, i) => args[i - 1] === '--lead-ids')
const statusArg = String(args.find((a, i) => args[i - 1] === '--status') || '').trim()
const statusIds = statusArg
  ? statusArg.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
  : reativarPing
    ? [AGENT_FUNNEL_STATUS_ID]
    : null
const filterIds = leadIdsArg
  ? new Set(leadIdsArg.split(',').map((s) => Number(s.trim())).filter((n) => n > 0))
  : null

const SKIP_FORM = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
])

const DEBOUNCE_MS = 6000

// Marca da resposta de fallback enviada durante o apagão da OpenAI (HTTP 429).
// Ver buildOpenAiTransientFallbackReply() em server/ai/agentRunner.js.
const FALLBACK_REPLY_RE = /instabilidade moment[âa]nea ao processar sua mensagem/i
const AGENT_NOTE_RE =
  /assistente|faculdade sumaré|sou o assistente|sou assistente|encaminhei seu atendimento|já encaminhei|bem-vindo|bem vindo|estou passando para ver|\s-\sEX-\d{6}/i
const SUM_NIVEL_FIELD_ID = Number(process.env.KOMMO_FIELD_SUM_NIVEL_ID) || 1475427

function analyzeHistory(rows) {
  const chronological = [...(rows || [])].reverse()
  let lastUser = null
  let lastBot = null
  for (const row of chronological) {
    const u = String(row?.user_message || '').trim()
    const b = String(row?.bot_message || '').trim()
    if (u) lastUser = u
    if (b) lastBot = b
  }
  const pending =
    lastUser &&
    (!lastBot ||
      chronological.findIndex((r) => String(r?.user_message || '').trim() === lastUser) >
        chronological.findIndex((r) => String(r?.bot_message || '').trim() === lastBot))
  // Recuperação: se a última fala do bot foi o fallback de instabilidade e há
  // pergunta do lead, o lead ficou sem resposta de verdade — força o reenvio.
  const fallbackLast = Boolean(lastBot && FALLBACK_REPLY_RE.test(lastBot))
  const needsReply =
    Boolean(lastUser && (!lastBot || pending)) ||
    (recoverFallback && fallbackLast && Boolean(lastUser))
  return { lastUser, lastBot, needsReply, fallbackLast, agentSpokeLast: Boolean(lastBot && !needsReply) }
}

function firstName(nome) {
  const raw = String(nome || '').trim()
  if (!raw) return ''
  const first = raw.split(/\s+/)[0]
  if (!first || /\d/.test(first) || first.length < 2) return ''
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

function buildReativacaoMessage(nome) {
  const name = firstName(nome)
  const ola = name ? `Olá, ${name}!` : 'Olá!'
  return `${ola} Estou passando para ver se ainda posso te ajudar com as informações que você precisava. Você deseja continuar agora?`
}

function extractNivel(lead) {
  const fields = lead?.custom_fields_values
  if (!Array.isArray(fields)) return ''
  const f = fields.find((x) => Number(x?.field_id) === SUM_NIVEL_FIELD_ID)
  return f?.values?.[0]?.value ? String(f.values[0].value).trim() : ''
}

async function hasAgentKommoNote(leadId) {
  try {
    const notes = await listLeadNotes(env, leadId, { limit: 12 })
    for (const n of notes.notes || []) {
      const t = String(n?.params?.text || '').trim()
      if (AGENT_NOTE_RE.test(t)) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

async function sendReativacaoPing({ lead, lid, phone, text, pingKind }) {
  console.log(`[${dryRun ? 'would-ping' : 'ping'}] lead=${lid} phone=${phone} kind=${pingKind}`)
  if (dryRun) return true
  await updateDadosCliente(env, {
    telefone: phone,
    fields: { reativacao_ping_at: null, reativacao_moved_at: null },
  }).catch(() => {})
  const executionId = generateExecutionId()
  const sendRes = await sendMessageWithNote(env, {
    telefone: phone,
    text,
    leadId: lid,
    executionId,
  })
  if (sendRes?.ok && !sendRes.deduped) {
    await saveConversation(env, {
      telefone: phone,
      userMessage: '',
      botMessage: text,
      messageType: 'reativacao_fila_atendimento',
      idLead: lid,
    }).catch(() => {})
    console.log(`  OK exec=${executionId}`)
    stats.ping_sent++
    await new Promise((r) => setTimeout(r, delayMs))
    return true
  }
  console.log(`  FALHA ok=${sendRes?.ok} deduped=${sendRes?.deduped} err=${sendRes?.error || sendRes?.reason || 'n/a'}`)
  stats.ping_fail++
  await new Promise((r) => setTimeout(r, delayMs))
  return false
}

async function listTargetLeads() {
  if (statusIds?.length) {
    const byId = new Map()
    for (const sid of statusIds) {
      const r = await listLeadsByStatus(env, {
        pipelineId: AGENT_FUNNEL_PIPELINE_ID,
        statusId: sid,
        maxPages: 20,
      })
      if (!r.ok) {
        console.error(`listLeadsByStatus status=${sid} falhou:`, r.error)
        continue
      }
      for (const l of r.leads || []) byId.set(Number(l.id), l)
    }
    return { ok: true, leads: [...byId.values()] }
  }
  return listLeadsInAgentQueue(env)
}

const listing = await listTargetLeads()
if (!listing.ok) {
  console.error('listLeadsInAgentQueue falhou:', listing.error)
  process.exit(1)
}

let leads = listing.leads || []
if (filterIds?.size) leads = leads.filter((l) => filterIds.has(Number(l.id)))
if (limit > 0) leads = leads.slice(0, limit)

console.log(
  `mode=${dryRun ? 'DRY-RUN' : 'APPLY'} recoverFallback=${recoverFallback} reativarPing=${reativarPing} status=[${statusIds?.join(',') || 'fila_ia'}] leads=${leads.length} total_queue=${listing.leads?.length}`,
)

const contactIds = []
for (const l of leads) {
  for (const c of l._embedded?.contacts || []) contactIds.push(Number(c.id))
}
const bulk = await bulkGetContactsByIds(env, [...new Set(contactIds)])
const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))

const stats = { skip: 0, synced: 0, seeded: 0, flushed: 0, ping_sent: 0, ping_fail: 0, errors: 0, idle: 0 }

for (const lead of leads) {
  const lid = Number(lead.id)
  let phone = null
  let contactId = null
  for (const c of lead._embedded?.contacts || []) {
    const p = extractContactPhone(byId.get(Number(c.id)))
    if (p) {
      phone = p
      contactId = Number(c.id)
      break
    }
  }
  if (!phone) {
    console.log(`[skip] lead=${lid} sem telefone`)
    stats.skip++
    continue
  }

  const sid = phoneToWhatsAppSessionId(phone)
  const row = await fetchDadosClienteByTelefone(env, phone, 'atendimento_ia,inscricao_form_status')
  if (String(row?.atendimento_ia || '').toLowerCase() === 'pause') {
    console.log(`[skip] lead=${lid} ia=paused`)
    stats.skip++
    continue
  }
  const formSt = String(row?.inscricao_form_status || '').trim()
  if (formSt && SKIP_FORM.has(formSt)) {
    console.log(`[skip] lead=${lid} form=${formSt}`)
    stats.skip++
    continue
  }

  let bufferBefore = await getMessages(env, sid)
  if (bufferBefore?.length > 0) {
    console.log(`[ready] lead=${lid} buffer=${bufferBefore.length} — já tem fila`)
    if (!dryRun) {
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS))
      const out = await flushSession(env, sid, { leadIdHint: lid })
      console.log(`  flush ok=${out?.ok} reply=${String(out?.reply || '').slice(0, 80)}`)
      if (out?.ok) stats.flushed++
      else stats.errors++
    }
    continue
  }

  resetKommoInboundPollStateForLead(lid)
  const syncRes = await syncKommoInboundToBuffer(env, {
    leadId: lid,
    sessionId: sid,
    phone,
    contactId: contactId > 0 ? contactId : null,
  })
  stats.synced++

  let bufferAfter = await getMessages(env, sid)
  let seedSource = null

  if (!bufferAfter?.length) {
    const hist = await fetchRecentChatRows(env, phone, 30)
    const { lastUser, lastBot, needsReply, agentSpokeLast } = analyzeHistory(hist)
    if (needsReply && lastUser) {
      seedSource = `history:${lastUser.slice(0, 40)}`
      if (!dryRun) {
        await pushMessage(env, sid, lastUser, { skipDedupe: true })
        stats.seeded++
      }
      bufferAfter = dryRun ? [lastUser] : await getMessages(env, sid)
    } else if (reativarPing) {
      const kommoAgent = await hasAgentKommoNote(lid)
      let pingKind = null
      let text = null
      if (agentSpokeLast || kommoAgent) {
        pingKind = kommoAgent && !lastBot ? 'kommo_note' : 'agent_spoke_last'
        text = buildReativacaoMessage(lead.name)
      } else if (!lastUser && !lastBot) {
        pingKind = 'saudacao_inicial'
        text = buildGreeting({ nome: lead.name, nivel: extractNivel(lead) })
      }
      if (text) {
        await sendReativacaoPing({ lead, lid, phone, text, pingKind })
      } else {
        console.log(`[idle] lead=${lid} sem critério de ping (sync=${syncRes.pushed})`)
        stats.idle++
      }
      continue
    } else if (lastBot && !lastUser) {
      console.log(`[idle] lead=${lid} agente já respondeu, aguardando lead`)
      stats.idle++
      continue
    } else {
      console.log(`[idle] lead=${lid} sem inbound (sync=${syncRes.pushed} hist_user=${lastUser ? 'sim' : 'não'})`)
      stats.idle++
      continue
    }
  }

  console.log(
    `[${dryRun ? 'would-flush' : 'flush'}] lead=${lid} phone=${phone} buffer=${bufferAfter?.length || 0} sync=${syncRes.pushed} seed=${seedSource || 'poll'}`,
  )

  if (!dryRun && bufferAfter?.length > 0) {
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS))
    const out = await flushSession(env, sid, { leadIdHint: lid })
    console.log(`  ok=${out?.ok} reply=${String(out?.reply || '').slice(0, 120)}`)
    if (out?.ok) stats.flushed++
    else stats.errors++
  }
}

console.log('\n--- resumo ---')
console.log(JSON.stringify(stats, null, 2))
