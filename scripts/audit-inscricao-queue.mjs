/**
 * Audita leads na etapa "inscrição" (106804680) e classifica passos pendentes.
 * Opcionalmente reprocessa captação para leads com formulário preenchido sem boleto.
 *
 *   node scripts/audit-inscricao-queue.mjs [--apply] [--retry-captacao]
 */
import fs from 'node:fs'
import { listLeadsByStatus, bulkGetContactsByIds, extractContactPhone } from '../server/kommoClient.js'
import {
  AGENT_FUNNEL_PIPELINE_ID,
  AGENT_FUNNEL_STATUS_INSCRICAO,
} from '../server/kommoAgentFunnelGate.js'
import { fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'
import { fetchLeadFormSnapshot } from '../server/inscricaoKommoFields.js'
import { executeCaptacaoAfterFormResolved } from '../server/inscricaoPostFormPipeline.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_AGUARDANDO_AUTORIZACAO,
  INSCRICAO_FORM_STATUS_MATRICULA_AUTORIZADA,
  inscricaoFormAlreadyFilled,
} from '../libShared/inscricaoFormHeuristics.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'

const env = { ...process.env }
const envFile = process.env.ENV_FILE || '.env.recovery'
for (const file of [envFile, '.env']) {
  if (!fs.existsSync(file)) continue
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!env[k]) env[k] = line.slice(i + 1)
  }
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const retryCaptacao = args.includes('--retry-captacao')

function classifyLead(row, snap) {
  const status = row?.inscricao_form_status ?? null
  const hasForm = inscricaoFormAlreadyFilled(row) || Boolean(row?.inscricao_form_recebido_at)
  const hasCaptacao =
    Boolean(row?.captacao_candidato_id) ||
    Boolean(row?.captacao_contrato_link) ||
    Boolean(row?.captacao_contrato_link_at)
  const hasPolo = Boolean(row?.polo_inscricao_escolhido && row?.captacao_unidade)

  if (!status && !hasForm) return 'sem_status_aguardando_inicio'
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_AUTORIZACAO) return 'aguardando_autorizacao_matricula'
  if (status === INSCRICAO_FORM_STATUS_MATRICULA_AUTORIZADA) return 'matricula_autorizada_sem_form'
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM) return 'aguardando_polo_pre_form'
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO && !hasForm) return 'form_disparado_aguardando_preenchimento'
  if (hasForm && status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO) return 'form_preenchido_aguardando_captacao'
  if (hasForm && status === INSCRICAO_FORM_STATUS_AGUARDANDO_POLO) return 'form_preenchido_aguardando_polo'
  if (status === INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR && hasForm && !hasCaptacao) {
    return 'captacao_falhou_distribuir_consultor'
  }
  if (hasForm && !hasCaptacao && !hasPolo) return 'form_preenchido_sem_polo'
  if (hasForm && !hasCaptacao) return 'form_preenchido_sem_captacao'
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE || hasCaptacao) return 'captacao_ok_aguardando_aceite'
  return `outro:${status || 'null'}`
}

function actionForBucket(bucket) {
  if (bucket === 'form_preenchido_aguardando_captacao') return 'retry_captacao'
  if (bucket === 'form_preenchido_sem_captacao') return 'retry_captacao'
  if (bucket === 'captacao_falhou_distribuir_consultor') return 'retry_captacao_cpf_fix'
  if (bucket === 'matricula_autorizada_sem_form') return 'flush_agente_enviar_form'
  if (bucket === 'aguardando_autorizacao_matricula') return 'aguardar_lead_ou_flush'
  if (bucket === 'aguardando_polo_pre_form') return 'flush_agente_pedir_polo'
  if (bucket === 'form_disparado_aguardando_preenchimento') return 'aguardar_formulario'
  return 'revisar_manual'
}

const listing = await listLeadsByStatus(env, {
  pipelineId: AGENT_FUNNEL_PIPELINE_ID,
  statusId: AGENT_FUNNEL_STATUS_INSCRICAO,
})
if (!listing.ok) {
  console.error('Falha ao listar inscrição:', listing.error)
  process.exit(1)
}

const leads = listing.leads || []
const contactIds = [...new Set(leads.flatMap((l) => (l._embedded?.contacts || []).map((c) => c.id)).filter(Boolean))]
const bulkContacts = await bulkGetContactsByIds(env, contactIds)
const contactById = new Map((bulkContacts.contacts || []).map((c) => [Number(c.id), c]))
const phoneByLead = new Map()
for (const lead of leads) {
  for (const c of lead._embedded?.contacts || []) {
    const full = contactById.get(Number(c.id))
    const phone = extractContactPhone(full)
    if (phone) {
      phoneByLead.set(Number(lead.id), phone)
      break
    }
  }
}

const buckets = new Map()
const details = []

for (const lead of leads) {
  const leadId = Number(lead.id)
  const phone = phoneByLead.get(leadId)
  let row = null
  let snap = null
  if (phone) {
    row = await fetchDadosClienteByTelefone(env, phone, '*').catch(() => null)
    snap = await fetchLeadFormSnapshot(env, leadId).catch(() => null)
  }
  const bucket = classifyLead(row, snap)
  buckets.set(bucket, (buckets.get(bucket) || 0) + 1)
  const action = actionForBucket(bucket)
  details.push({
    leadId,
    phone: phone || null,
    bucket,
    action,
    status: row?.inscricao_form_status ?? null,
    polo: row?.polo_inscricao_escolhido ?? null,
    cpf: snap?.snapshot?.cpf ?? null,
    curso: snap?.snapshot?.curso_inscricao ?? null,
    captacao: row?.captacao_candidato_id ?? null,
  })
}

console.log(`\n=== Fila inscrição (${AGENT_FUNNEL_STATUS_INSCRICAO}) — ${leads.length} leads ===`)
console.log(`mode=${apply ? 'APPLY' : 'DRY-RUN'} retryCaptacao=${retryCaptacao}\n`)

for (const [bucket, count] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${bucket}: ${count}`)
}

console.log('\n--- Detalhes ---')
for (const d of details) {
  console.log(
    JSON.stringify({
      leadId: d.leadId,
      bucket: d.bucket,
      action: d.action,
      status: d.status,
      polo: d.polo,
      curso: d.curso,
      cpf: d.cpf,
      captacao: d.captacao,
    }),
  )
}

if (!apply || !retryCaptacao) {
  console.log('\nRode com --apply --retry-captacao para reprocessar captação elegível.')
  process.exit(0)
}

let ok = 0
let fail = 0
for (const d of details) {
  if (!['retry_captacao', 'retry_captacao_cpf_fix', 'form_preenchido_aguardando_captacao', 'form_preenchido_sem_captacao'].includes(d.action)) {
    continue
  }
  if (!d.phone) {
    console.warn(`skip lead ${d.leadId} sem telefone`)
    fail += 1
    continue
  }
  console.log(`\n>> retry captação lead=${d.leadId} bucket=${d.bucket}`)
  try {
    const res = await executeCaptacaoAfterFormResolved(env, {
      telefone: d.phone,
      idLead: d.leadId,
      executionId: generateExecutionId(),
      pushName: '',
    })
    if (res?.ok || res?.contratoWhatsappSent || res?.ctxForm === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) {
      console.log('   OK', res.ctxForm || res.reply?.slice(0, 80))
      ok += 1
    } else {
      console.log('   FALHA', res?.reply || res?.ctxForm || res)
      fail += 1
    }
  } catch (err) {
    console.error('   ERRO', err?.message || err)
    fail += 1
  }
}

console.log(`\nCaptação: ${ok} ok, ${fail} falha`)
process.exit(fail > 0 ? 1 : 0)
