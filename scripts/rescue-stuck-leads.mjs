/**
 * Resgata leads "presos" em "Aguardando resposta" (106377088) que MANDARAM
 * mensagens mas nunca foram respondidos — porque esse status fica FORA do funil
 * do agente, então o scheduler ignora o buffer deles.
 *
 * Ação: mover o lead para "Atendimento" (106140284). O scheduler de produção
 * então faz o flush do buffer e o agente responde as mensagens reais do lead.
 *
 * Uso:
 *   node scripts/rescue-stuck-leads.mjs --dry-run
 *   node scripts/rescue-stuck-leads.mjs --apply
 *   node scripts/rescue-stuck-leads.mjs --apply --limit 20
 *
 * Flags:
 *   --apply       move de verdade (sem isso é dry-run)
 *   --limit N     no máximo N leads (mais ANTIGOS com buffer primeiro)
 *   --from S      status de origem (default 106377088)
 *   --to S        status de destino (default 106140284 = Atendimento)
 */
import fs from 'node:fs'
import {
  listLeadsByStatus,
  bulkGetContactsByIds,
  extractContactPhone,
  updateLeadPipelineStatus,
} from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId, whatsAppSessionVariants } from '../server/phoneWhatsApp.js'
import { getMessages } from '../server/evolution/messageBuffer.js'
import { fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'

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
const limitRaw = Number(args.find((a, i) => args[i - 1] === '--limit'))
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : Infinity
const fromStatus = Number(args.find((a, i) => args[i - 1] === '--from')) || 106377088
const toStatus = Number(args.find((a, i) => args[i - 1] === '--to')) || 106140284
const PIPELINE_ID = 13756724

async function bufferCount(phone) {
  let total = 0
  for (const sid of whatsAppSessionVariants(phone)) {
    try {
      const msgs = await getMessages(env, sid)
      total += Array.isArray(msgs) ? msgs.length : 0
    } catch {
      /* ignore */
    }
  }
  return total
}

const r = await listLeadsByStatus(env, { pipelineId: PIPELINE_ID, statusId: fromStatus })
if (!r.ok && !(r.leads || []).length) {
  console.error('falha listar status', fromStatus, r.error)
  process.exit(1)
}
const leads = (r.leads || []).sort((a, b) => (Number(a?.created_at) || 0) - (Number(b?.created_at) || 0))
console.log(`[fonte] status=${fromStatus} pipeline=${PIPELINE_ID} total=${leads.length} -> destino=${toStatus}`)

const contactIds = []
for (const l of leads) for (const c of l._embedded?.contacts || []) contactIds.push(Number(c.id))
const bulk = await bulkGetContactsByIds(env, [...new Set(contactIds)])
const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))

const stats = { moved: 0, skipNoPhone: 0, skipNoBuffer: 0, skipPause: 0, skipForm: 0, fail: 0, targets: 0 }

for (const lead of leads) {
  const lid = Number(lead.id)
  let phone = null
  for (const c of lead._embedded?.contacts || []) {
    const p = extractContactPhone(byId.get(Number(c.id)))
    if (p) { phone = p; break }
  }
  if (!phone) { stats.skipNoPhone++; continue }

  const nBuf = await bufferCount(phone)
  if (nBuf === 0) { stats.skipNoBuffer++; continue }

  const dc = await fetchDadosClienteByTelefone(env, phone, 'atendimento_ia,inscricao_form_status')
  if (String(dc?.atendimento_ia || '').toLowerCase() === 'pause') {
    console.log(`[skip] lead=${lid} ia_paused (buffer=${nBuf})`)
    stats.skipPause++
    continue
  }
  const formSt = String(dc?.inscricao_form_status || '').trim()
  if (formSt && SKIP_FORM.has(formSt)) {
    console.log(`[skip] lead=${lid} form=${formSt} (buffer=${nBuf})`)
    stats.skipForm++
    continue
  }

  stats.targets++
  const created = lead.created_at ? new Date(Number(lead.created_at) * 1000).toISOString().slice(0, 16) : '?'
  console.log(`[${dryRun ? 'would-move' : 'move'}] lead=${lid} "${String(lead.name || '').slice(0, 28)}" phone=${phone} buffer=${nBuf} criado=${created}`)

  if (!dryRun) {
    const mv = await updateLeadPipelineStatus(env, lid, { pipelineId: PIPELINE_ID, statusId: toStatus })
    if (!mv.ok) {
      console.log(`  FALHA mover: ${mv.error || mv.code}`)
      stats.fail++
    } else {
      stats.moved++
    }
    await new Promise((res) => setTimeout(res, 400))
  }

  if (stats.targets >= limit) {
    console.log(`[limit] atingido ${limit} — parando.`)
    break
  }
}

console.log('\n--- resumo ---')
console.log(`mode=${dryRun ? 'DRY-RUN' : 'APPLY'}`)
console.log(JSON.stringify(stats, null, 2))
console.log('\nApós mover, o scheduler de produção faz o flush do buffer e o agente responde.')
