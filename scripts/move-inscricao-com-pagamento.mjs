/**
 * Lista deals na fila Inscrição e move para Aguardando pagamento
 * os que já receberam o link de pagamento da matrícula.
 *
 *   node scripts/move-inscricao-com-pagamento.mjs
 *   node scripts/move-inscricao-com-pagamento.mjs --apply
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listDealsByStageId, resolveEduitStages, contactPhoneDigits, listConversationMessages } from '../server/eduitClient.js'
import { fetchDadosClienteByLeadId, fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'
import { moveLeadToAguardandoPagamentoIfNeeded } from '../server/kommoFunnelMoves.js'
import {
  looksLikeMatriculaPagamentoUrl,
  rowHasPagamentoLinkEnviado,
  historyHasPagamentoLink,
} from '../libShared/matriculaPagamentoLink.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

function loadEnv() {
  const env = { ...process.env }
  for (const file of ['.env', '.env.recovery']) {
    const p = path.join(root, file)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue
      const i = line.indexOf('=')
      const k = line.slice(0, i).trim()
      if (k && !env[k]) env[k] = line.slice(i + 1)
    }
  }
  if (!env.CRM_BACKEND) env.CRM_BACKEND = 'eduit'
  return env
}

const env = loadEnv()
const apply = process.argv.includes('--apply')
const stages = resolveEduitStages(env)
const SELECT =
  'telefone,eduit_deal_id,captacao_contrato_link,captacao_contrato_link_at,captacao_candidato_id,inscricao_form_status'

function dealTitle(deal) {
  return String(deal?.title || deal?.name || deal?.number || deal?.id || '').trim()
}

async function rowForDeal(deal) {
  const byId = await fetchDadosClienteByLeadId(env, deal.id, SELECT)
  if (byId) return byId
  const phones = contactPhoneDigits(deal.contact || deal.Contact || {})
  for (const phone of phones) {
    const row = await fetchDadosClienteByTelefone(env, phone, SELECT)
    if (row) return row
  }
  return null
}

async function chatHasLink(deal) {
  const convId =
    deal.conversationId ||
    deal.conversation_id ||
    deal.conversations?.[0]?.id ||
    deal.contact?.conversations?.[0]?.id
  if (!convId) return false
  const listed = await listConversationMessages(env, convId, { limit: 80 })
  return listed.ok && historyHasPagamentoLink(listed.messages)
}

async function classify(deal) {
  const row = await rowForDeal(deal)
  const fromRow = rowHasPagamentoLinkEnviado(row)
  const fromUrl = looksLikeMatriculaPagamentoUrl(row?.captacao_contrato_link)
  let fromChat = false
  if (!fromRow) {
    fromChat = await chatHasLink(deal).catch(() => false)
  }
  const move = fromRow || fromChat
  return {
    id: deal.id,
    number: deal.number,
    title: dealTitle(deal),
    telefone: row?.telefone || '',
    status: row?.inscricao_form_status || '',
    link: String(row?.captacao_contrato_link || '').slice(0, 80),
    fromRow,
    fromUrl,
    fromChat,
    move,
  }
}

const listed = await listDealsByStageId(env, stages.inscricao, { perPage: 100, maxPages: 10 })
if (!listed.ok) {
  console.error('Falha ao listar Inscrição:', listed.error || listed.code)
  process.exit(1)
}

const deals = listed.deals || []
console.log(`Inscrição: ${deals.length} negócios`)

const rows = []
for (const deal of deals) {
  const item = await classify(deal)
  rows.push(item)
  const flag = item.move ? 'MOVER' : 'ficar'
  console.log(
    `  [${flag}] #${item.number || '?'} ${item.title} status=${item.status || 'n/a'} link=${item.fromUrl || item.fromRow || item.fromChat}`,
  )
}

const toMove = rows.filter((r) => r.move)
console.log(`\nCom link de pagamento: ${toMove.length}`)
console.log(`Sem link (permanecem em Inscrição): ${rows.length - toMove.length}`)

if (!apply) {
  console.log('\nDry-run. Passe --apply para mover.')
  process.exit(0)
}

let moved = 0
let failed = 0
for (const item of toMove) {
  const r = await moveLeadToAguardandoPagamentoIfNeeded(env, item.id, {
    reason: 'backfill_link_pagamento',
  })
  if (r.ok && r.moved) {
    moved += 1
    console.log(`  movido #${item.number || item.id}`)
  } else if (r.ok && r.skipped) {
    console.log(`  skip #${item.number || item.id} ${r.reason}`)
  } else {
    failed += 1
    console.log(`  falha #${item.number || item.id} ${r.error || r.reason}`)
  }
}
console.log(`\nAplicado: movidos=${moved} falhas=${failed}`)
