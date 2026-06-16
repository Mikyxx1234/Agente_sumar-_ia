/**
 * Audita leads na coluna Atendimento que já estão na jornada de inscrição
 * (dados_cliente / captação) e corrige movendo para Inscrição.
 *
 *   node scripts/audit-funnel-mismatch.mjs
 *   node scripts/audit-funnel-mismatch.mjs --apply
 *   node scripts/audit-funnel-mismatch.mjs --apply --lead-id 23957305
 */
import fs from 'node:fs'
import {
  listLeadsByStatus,
  bulkGetContactsByIds,
  extractContactPhone,
  getLeadById,
  getLeadSummary,
} from '../server/kommoClient.js'
import {
  AGENT_FUNNEL_PIPELINE_ID,
  AGENT_FUNNEL_STATUS_ID,
} from '../server/kommoAgentFunnelGate.js'
import { fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'
import { digitsToWhatsAppLocalPart } from '../server/phoneWhatsApp.js'
import {
  dadosClienteRequiresInscricaoFunnel,
  moveLeadToInscricaoIfNeeded,
} from '../server/kommoFunnelMoves.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const onlyLeadId = Number(args.find((a, i) => args[i - 1] === '--lead-id') || 0) || 0

function normalizePhone(raw) {
  return digitsToWhatsAppLocalPart(raw) || null
}

async function fetchDadosClienteByLeadId(leadId) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
  const table = env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum'
  if (!url || !key) return null
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) return null
  try {
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?id_lead=eq.${id}&select=*&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    )
    const data = await res.json()
    return Array.isArray(data) && data.length ? data[0] : null
  } catch {
    return null
  }
}

async function resolveDadosRow(leadId, phoneRaw) {
  const phone = normalizePhone(phoneRaw)
  let row = phone ? await fetchDadosClienteByTelefone(env, phone).catch(() => null) : null
  if (!row) row = await fetchDadosClienteByLeadId(leadId)
  return { row, phone }
}

async function auditLead(leadId, phoneRaw, { kommoStatusId = null } = {}) {
  const { row, phone } = await resolveDadosRow(leadId, phoneRaw)
  const inInscricaoJourney = dadosClienteRequiresInscricaoFunnel(row)
  const inAtendimento =
    kommoStatusId == null || Number(kommoStatusId) === AGENT_FUNNEL_STATUS_ID
  const needsMove = inAtendimento && inInscricaoJourney
  return {
    leadId,
    phone,
    needsMove,
    kommoStatusId,
    status: row?.inscricao_form_status ?? null,
    candidato: row?.captacao_candidato_id ?? null,
    contrato: Boolean(row?.captacao_contrato_link),
    id_lead_db: row?.id_lead ?? null,
  }
}

let targets = []

if (onlyLeadId > 0) {
  const s = await getLeadSummary(env, onlyLeadId)
  const got = await getLeadById(env, onlyLeadId)
  const kommoStatusId = got.ok ? got.lead?.status_id : null
  const item = await auditLead(onlyLeadId, s.phone, { kommoStatusId })
  targets = [item]
} else {
  const listing = await listLeadsByStatus(env, {
    pipelineId: AGENT_FUNNEL_PIPELINE_ID,
    statusId: AGENT_FUNNEL_STATUS_ID,
    limit: 250,
    maxPages: 4,
  })
  if (!listing.ok) {
    console.error('Falha ao listar Atendimento:', listing.error)
    process.exit(1)
  }
  const leads = listing.leads || []
  const contactIds = [
    ...new Set(leads.flatMap((l) => (l._embedded?.contacts || []).map((c) => c.id)).filter(Boolean)),
  ]
  const bulk = await bulkGetContactsByIds(env, contactIds)
  const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))
  const phoneByLead = new Map()
  for (const lead of leads) {
    for (const c of lead._embedded?.contacts || []) {
      const p = extractContactPhone(byId.get(Number(c.id)))
      if (p) {
        phoneByLead.set(Number(lead.id), normalizePhone(p))
        break
      }
    }
  }
  for (const lead of leads) {
    const lid = Number(lead.id)
    const item = await auditLead(lid, phoneByLead.get(lid), {
      kommoStatusId: lead.status_id,
    })
    if (item.needsMove) targets.push(item)
  }
}

const mismatchCount = targets.filter((t) => t.needsMove).length
console.log(`\n=== Funnel mismatch (Atendimento → deveria Inscrição) ===`)
console.log(`mode=${apply ? 'APPLY' : 'DRY-RUN'} scanned=${onlyLeadId ? 1 : 'atendimento queue'} mismatches=${mismatchCount}\n`)

for (const t of targets) {
  console.log(JSON.stringify(t))
  if (apply && t.needsMove) {
    const mv = await moveLeadToInscricaoIfNeeded(env, t.leadId, {
      reason: 'audit_funnel_mismatch',
    })
    console.log('  → move', mv.moved ? 'OK' : mv.skipped ? `skip:${mv.reason}` : `fail:${mv.error}`)
  }
}

if (!apply && mismatchCount) {
  console.log('\nRode com --apply para corrigir.')
}
