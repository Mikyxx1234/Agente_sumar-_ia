/**
 * Leads na fila Aguardando pagamento com gerar/captação falha e sum_Origem Api Sumaré
 * → ativa salesbot BV aguard_pgt_sumare_api (49979).
 *
 *   node --env-file=.env scripts/activate-aguard-pgt-api-salesbot.mjs
 *   node --env-file=.env scripts/activate-aguard-pgt-api-salesbot.mjs --apply
 *   node --env-file=.env scripts/activate-aguard-pgt-api-salesbot.mjs --apply --lead-id 23856713
 */
import fs from 'node:fs'
import { listLeadsByStatus, bulkGetContactsByIds, extractContactPhone } from '../server/kommoClient.js'
import { resolvePosMatriculaTarget } from '../server/inscricaoAceitePagamentoFlow.js'
import { fetchDadosClienteByTelefone, ensureDadosClienteRow, updateDadosCliente } from '../server/dadosClienteStore.js'
import { fetchLeadFormSnapshot } from '../server/inscricaoKommoFields.js'
import { isApiSumareOrigemSnapshot } from '../libShared/apiSumareOrigemHeuristics.js'
import { API_SUMARE_SALESBOT_PAGAMENTO_ID } from '../libShared/apiSumareOrigemHeuristics.js'
import { runKommoSalesbot } from '../server/kommoSalesbot.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  env[line.slice(0, i).trim()] ||= line.slice(i + 1)
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const singleLead = Number(args.find((a, i) => args[i - 1] === '--lead-id') || 0) || 0
const INTER_MS = 1500

const SELECT =
  'telefone,inscricao_form_status,atendimento_ia,captacao_candidato_id,captacao_contrato_link,id_lead'

const { pipelineId, statusId } = resolvePosMatriculaTarget(env)

const listing = await listLeadsByStatus(env, { pipelineId, statusId, limit: 250, maxPages: 10 })
if (!listing.ok) throw new Error(listing.error || 'listLeadsByStatus failed')

const leads = (listing.leads || []).filter((l) => !singleLead || Number(l.id) === singleLead)
const contactIds = [
  ...new Set(leads.flatMap((l) => (l._embedded?.contacts || []).map((c) => c.id)).filter(Boolean)),
]
const bulk = await bulkGetContactsByIds(env, contactIds)
const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))

const candidates = []
const skipped = []

for (const lead of leads) {
  const leadId = Number(lead.id)
  const name = String(lead.name || '').trim() || '(sem nome)'
  let phone = null
  for (const c of lead._embedded?.contacts || []) {
    phone = extractContactPhone(byId.get(Number(c.id)))
    if (phone) break
  }

  const snapRes = await fetchLeadFormSnapshot(env, leadId).catch(() => null)
  const snapshot = snapRes?.snapshot || {}
  const origem = String(snapshot.origem || '').trim()

  if (!isApiSumareOrigemSnapshot(snapshot)) {
    skipped.push({ leadId, name, reason: `origem=${origem || 'vazia'}` })
    continue
  }

  const row = phone ? await fetchDadosClienteByTelefone(env, phone, SELECT).catch(() => null) : null
  const candidato = String(row?.captacao_candidato_id || '').trim()
  if (candidato) {
    skipped.push({ leadId, name, reason: `ja_tem_candidato=${candidato}` })
    continue
  }

  candidates.push({
    leadId,
    name,
    phone,
    origem,
    curso: snapshot.curso_inscricao || null,
    cpf: snapshot.cpf || null,
    status: row?.inscricao_form_status ?? null,
  })
  await new Promise((r) => setTimeout(r, 120))
}

console.log(
  `# Aguardando pagamento — salesbot Api Sumaré (${API_SUMARE_SALESBOT_PAGAMENTO_ID}) mode=${apply ? 'APPLY' : 'DRY-RUN'}`,
)
console.log(`candidates=${candidates.length} skipped=${skipped.length}\n`)

for (const c of candidates) {
  console.log(
    `- #${c.leadId} ${c.name} | origem=${c.origem} | curso=${c.curso || 'n/a'} | cpf=${c.cpf ? 'sim' : 'nao'}`,
  )
}

if (skipped.length) {
  console.log(`\n## Ignorados (${skipped.length})\n`)
  for (const s of skipped.slice(0, 20)) {
    console.log(`- #${s.leadId} ${s.name} | ${s.reason}`)
  }
  if (skipped.length > 20) console.log(`  … +${skipped.length - 20}`)
}

const stats = { ok: 0, skip: 0, fail: 0 }

if (apply && candidates.length) {
  console.log(`\n>> Ativando salesbot ${API_SUMARE_SALESBOT_PAGAMENTO_ID}\n`)
  for (const c of candidates) {
    const executionId = generateExecutionId()
    console.log(`>> lead=${c.leadId} ${c.name}`)
    if (c.phone) {
      await ensureDadosClienteRow(env, {
        telefone: c.phone,
        idLead: c.leadId,
        fields: { id_lead: c.leadId, teste_ab: 'IA', atendimento_ia: 'pause' },
      }).catch(() => {})
      await updateDadosCliente(env, {
        telefone: c.phone,
        fields: { atendimento_ia: 'pause' },
      }).catch(() => {})
    }

    const out = await runKommoSalesbot(env, c.leadId, 'aguard_pgt_api_sumare', {
      force: true,
      note:
        `Salesbot BV aguard_pgt_sumare_api (#${API_SUMARE_SALESBOT_PAGAMENTO_ID}) ativado — ` +
        `captação automática indisponível, origem Api Sumaré — ${executionId}`,
    })

    if (out.ok && !out.skipped) {
      console.log(`   OK bot=${out.botId} status=${out.status}`)
      stats.ok++
    } else if (out.skipped) {
      console.log(`   SKIP ${out.reason}`)
      stats.skip++
    } else {
      console.log(`   FAIL status=${out.status} ${out.text || out.reason || ''}`)
      stats.fail++
    }
    await new Promise((r) => setTimeout(r, INTER_MS))
  }
  console.log(`\nResultado: ${stats.ok} ok, ${stats.skip} skip, ${stats.fail} falha`)
}
