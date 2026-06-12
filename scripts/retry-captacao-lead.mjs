/**
 * Reprocessa captação (boleto/contrato) para um lead após correção de dados.
 *
 *   node scripts/retry-captacao-lead.mjs --lead-id 23901381 [--apply]
 */
import fs from 'node:fs'
import { fetchLeadFormSnapshot } from '../server/inscricaoKommoFields.js'
import { extractContactPhone } from '../server/kommoClient.js'
import {
  marcarClienteIA,
  updateDadosCliente,
  fetchDadosClienteByTelefone,
} from '../server/dadosClienteStore.js'
import { executeCaptacaoAfterFormResolved } from '../server/inscricaoPostFormPipeline.js'
import { INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO } from '../libShared/inscricaoFormHeuristics.js'
import { resolvePoloUnidadeCode } from '../libShared/sumarePoloCatalog.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'

const env = { ...process.env }
const envFile = process.env.ENV_FILE || '.env.recovery'
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!env[k]) env[k] = line.slice(i + 1)
  }
}

const args = process.argv.slice(2)
const dryRun = !args.includes('--apply')
const leadId = Number(args.find((a, i) => args[i - 1] === '--lead-id') || args[0])
if (!Number.isFinite(leadId) || leadId <= 0) {
  console.error('Uso: node scripts/retry-captacao-lead.mjs --lead-id <id> [--apply]')
  process.exit(1)
}

const KBASE = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
const KTOK = env.KOMMO_ACCESS_TOKEN || ''

const leadRes = await fetch(`${KBASE}/api/v4/leads/${leadId}?with=contacts`, {
  headers: { Authorization: `Bearer ${KTOK}`, Accept: 'application/json' },
})
const lead = await leadRes.json()
if (!lead?.id) {
  console.error('lead não encontrado', leadId)
  process.exit(1)
}

let phone = null
for (const c of lead._embedded?.contacts || []) {
  const cr = await fetch(`${KBASE}/api/v4/contacts/${c.id}`, {
    headers: { Authorization: `Bearer ${KTOK}`, Accept: 'application/json' },
  })
  const contact = await cr.json()
  phone = extractContactPhone(contact)
  if (phone) break
}
if (!phone) {
  console.error('lead sem telefone')
  process.exit(1)
}

const snapRes = await fetchLeadFormSnapshot(env, leadId)
console.log('mode=', dryRun ? 'DRY-RUN' : 'APPLY', 'lead=', leadId, 'phone=', phone)
console.log('snapshot cpf=', snapRes.snapshot?.cpf, 'curso=', snapRes.snapshot?.curso_inscricao)

if (dryRun) {
  console.log('rode com --apply para executar captação')
  process.exit(0)
}

await marcarClienteIA(env, { telefone: phone, idLead: leadId }).catch(() => {})

await updateDadosCliente(env, {
  telefone: phone,
  fields: {
    atendimento_ia: null,
    inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
    polo_inscricao_escolhido: 'Barra Funda',
    captacao_unidade: resolvePoloUnidadeCode('barra-funda', env) || 'ED_SP_P5',
    captacao_contrato_link_at: null,
    captacao_contrato_link: null,
  },
})

const executionId = generateExecutionId()
const capOut = await executeCaptacaoAfterFormResolved(env, {
  telefone: phone,
  idLead: leadId,
  executionId,
  model: 'retry-captacao',
  pushName: snapRes.snapshot?.nome || lead.name,
  t0: Date.now(),
  snapshotOverride: {
    ...(snapRes.snapshot || {}),
    unidade: resolvePoloUnidadeCode('barra-funda', env) || 'ED_SP_P5',
    polo_inscricao: 'Barra Funda',
  },
})

console.log('\n--- resultado ---')
console.log(
  JSON.stringify(
    {
      ok: capOut.ok,
      ctxForm: capOut.ctxForm,
      contratoWhatsappSent: capOut.contratoWhatsappSent,
      reply: String(capOut.reply || '').slice(0, 200),
      steps: (capOut.steps || []).map((s) => ({
        type: s.type,
        ok: s.ok,
        code: s.code,
        error: s.error,
        contract_url: s.contract_url ? String(s.contract_url).slice(0, 80) : undefined,
      })),
    },
    null,
    2,
  ),
)

const row = await fetchDadosClienteByTelefone(
  env,
  phone,
  'inscricao_form_status,atendimento_ia,captacao_candidato_id,captacao_contrato_link',
)
console.log('dados_cliente depois:', row)

process.exit(capOut.contratoWhatsappSent || capOut.ok ? 0 : 1)
