/**
 * Audita leads na etapa "inscrição" (106804680) e classifica passos pendentes.
 *
 *   node scripts/audit-inscricao-queue.mjs
 *   node scripts/audit-inscricao-queue.mjs --apply --retry-captacao
 *   node scripts/audit-inscricao-queue.mjs --apply --handle
 */
import fs from 'node:fs'
import { listLeadsByStatus, bulkGetContactsByIds, extractContactPhone } from '../server/kommoClient.js'
import {
  AGENT_FUNNEL_PIPELINE_ID,
  AGENT_FUNNEL_STATUS_INSCRICAO,
} from '../server/kommoAgentFunnelGate.js'
import { fetchDadosClienteByTelefone, updateDadosCliente, ensureDadosClienteRow } from '../server/dadosClienteStore.js'
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
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO,
  buildContratoAceiteLinkReply,
  inscricaoFormAlreadyFilled,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  buildPoloEscolhaPreFormMessage,
  resolvePoloFromKommoSnapshot,
  resolvePoloUnidadeCode,
} from '../libShared/sumarePoloCatalog.js'
import { evaluateKommoExpressReadiness, mirrorKommoCardToDadosCliente } from '../server/kommoCardMirror.js'
import { analyzeCursoInscricaoSnapshot } from '../libShared/captacaoSnapshotSanitize.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'
import { sendMessageWithNote } from '../server/whatsappSender.js'
import { runDistribuirHumano } from '../server/distribuirHumanoTool.js'
import { flushSession } from '../server/evolution/webhookEvolution.js'
import { getMessages, pushMessage } from '../server/evolution/messageBuffer.js'
import {
  syncKommoInboundToBuffer,
  resetKommoInboundPollStateForLead,
} from '../server/kommoInboundPoll.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'

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
const handleAll = args.includes('--handle') || args.includes('--handle-all')
const DEBOUNCE_MS = 6000
const INTER_LEAD_MS = 2500

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

function actionForBucket(bucket, row) {
  if (bucket === 'captacao_ok_aguardando_aceite' && !row?.inscricao_form_status) {
    return 'sync_status_aceite'
  }
  if (bucket === 'sem_status_aguardando_inicio') return 'iniciar_fluxo_inscricao'
  if (bucket === 'form_preenchido_aguardando_captacao') return 'retry_captacao'
  if (bucket === 'form_preenchido_sem_captacao') return 'retry_captacao'
  if (bucket === 'captacao_falhou_distribuir_consultor') return 'atender_distribuir_consultor'
  if (bucket === 'matricula_autorizada_sem_form') return 'flush_agente_enviar_form'
  if (bucket === 'aguardando_autorizacao_matricula') return 'aguardar_lead_ou_flush'
  if (bucket === 'aguardando_polo_pre_form') return 'flush_agente_pedir_polo'
  if (bucket === 'form_disparado_aguardando_preenchimento') return 'aguardar_formulario'
  return 'nenhuma'
}

async function setInscricaoStatus(telefone, leadId, status) {
  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: { inscricao_form_status: status },
  }).catch(() => {})
  return updateDadosCliente(env, { telefone, fields: { inscricao_form_status: status } })
}

async function sendLeadWhatsApp(d, text) {
  const executionId = generateExecutionId()
  const res = await sendMessageWithNote(env, {
    telefone: d.phone,
    text,
    leadId: d.leadId,
    executionId,
  })
  const sent = Boolean(res?.ok && (res.sent || 0) > 0)
  return { ...res, sent }
}

function buildConfirmaPoloKommoReply(poloNome) {
  return (
    `Perfeito! Vi aqui no seu cadastro que o polo escolhido é *${poloNome}*. ` +
    `Confirma que quer manter *${poloNome}* como polo da sua inscrição? ` +
    `Responda *sim* para seguir ou me diga o nome de outro polo (São Miguel, Barra Funda, Tatuapé, Santana ou Santo Amaro).`
  )
}

function buildPedirCursoReply() {
  return (
    `Olá! Para concluir sua inscrição na Faculdade Sumaré, preciso que me informe o *nome completo do curso* ` +
    `que deseja cursar (por exemplo: Pedagogia, Administração, Marketing). Assim que responder, seguimos com o próximo passo.`
  )
}

function buildConsultorCursoReply(curso) {
  const cursoBit = curso ? ` para *${curso}*` : ''
  return (
    `Obrigado! Recebi seu pedido de matrícula${cursoBit}. ` +
    `Esse curso precisa de apoio de um consultor para concluir a inscrição — ` +
    `em instantes alguém da equipe da Faculdade Sumaré vai continuar o atendimento com você por aqui.`
  )
}

async function flushLeadAgent(d, seed) {
  resetKommoInboundPollStateForLead(d.leadId)
  const sessionId = phoneToWhatsAppSessionId(d.phone)
  await syncKommoInboundToBuffer(env, {
    leadId: d.leadId,
    sessionId,
    phone: d.phone,
  })
  let msgs = await getMessages(env, sessionId)
  if (!msgs?.length && seed) {
    await pushMessage(env, sessionId, seed, { skipDedupe: true })
    msgs = await getMessages(env, sessionId)
  }
  if (!msgs?.length) return { ok: false, reason: 'buffer_vazio' }
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS))
  return flushSession(env, sessionId, { leadIdHint: d.leadId })
}

async function handleSyncStatusAceite(d) {
  await setInscricaoStatus(d.phone, d.leadId, INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE)
  return { ok: true, action: 'sync_status_aceite' }
}

async function handleIniciarFluxoInscricao(d) {
  const mirror = await mirrorKommoCardToDadosCliente(env, {
    telefone: d.phone,
    leadId: d.leadId,
    force: true,
  })
  const row = await fetchDadosClienteByTelefone(env, d.phone, '*').catch(() => null)
  const snapRes = mirror.snapshot
    ? { ok: true, snapshot: mirror.snapshot }
    : await fetchLeadFormSnapshot(env, d.leadId).catch(() => null)
  const snapshot = snapRes?.snapshot || {}

  if (row?.captacao_candidato_id || row?.captacao_contrato_link) {
    await setInscricaoStatus(d.phone, d.leadId, INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE)
    if (row.captacao_contrato_link) {
      const reply = buildContratoAceiteLinkReply({
        pushName: '',
        contractUrl: row.captacao_contrato_link,
        portalPhase: 'pagamento',
      })
      const sent = await sendLeadWhatsApp(d, reply)
      return { ok: sent.sent || sent.ok, action: 'resend_contrato_link' }
    }
    return { ok: true, action: 'sync_aceite_com_captacao' }
  }

  const readiness = evaluateKommoExpressReadiness(snapshot)
  if (readiness.ready) {
    const resolved = resolvePoloFromKommoSnapshot(snapshot, env)
    if (resolved?.polo) {
      await setInscricaoStatus(d.phone, d.leadId, INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO)
      await updateDadosCliente(env, {
        telefone: d.phone,
        fields: {
          polo_inscricao_escolhido: resolved.polo.nome,
          captacao_unidade: resolved.unidade,
        },
      }).catch(() => {})
      const sent = await sendLeadWhatsApp(d, buildConfirmaPoloKommoReply(resolved.polo.nome))
      return { ok: sent.sent || sent.ok, action: 'express_confirma_polo' }
    }
  }

  if (snapshot?.curso_inscricao || snapshot?.polo_inscricao) {
    await setInscricaoStatus(d.phone, d.leadId, INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM)
    const sent = await sendLeadWhatsApp(d, buildPoloEscolhaPreFormMessage({ pushName: '' }))
    return { ok: sent.sent || sent.ok, action: 'pedir_polo_pre_form' }
  }

  const out = await flushLeadAgent(d, 'Quero continuar minha inscrição na Faculdade Sumaré')
  return { ok: Boolean(out?.ok && out?.reply), action: 'flush_agente', reply: out?.reply?.slice(0, 80) }
}

async function handlePoloPreForm(d) {
  const row = await fetchDadosClienteByTelefone(env, d.phone, '*').catch(() => null)
  if (row?.captacao_candidato_id) {
    return handleSyncStatusAceite(d)
  }
  await setInscricaoStatus(d.phone, d.leadId, INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM)
  const sent = await sendLeadWhatsApp(d, buildPoloEscolhaPreFormMessage({ pushName: '' }))
  return { ok: sent.sent || sent.ok, action: 'reenviar_lista_polo' }
}

async function handleDistribuirConsultor(d) {
  const snapRes = await fetchLeadFormSnapshot(env, d.leadId).catch(() => null)
  const snapshot = snapRes?.snapshot || {}
  const curso = String(snapshot.curso_inscricao || d.curso || '').trim()
  const cursoCheck = await analyzeCursoInscricaoSnapshot(snapshot, env)

  if (!curso || cursoCheck.code === 'CURSO_AUSENTE') {
    await setInscricaoStatus(d.phone, d.leadId, INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO)
    const sent = await sendLeadWhatsApp(d, buildPedirCursoReply())
    return { ok: sent.sent || sent.ok, action: 'pedir_curso' }
  }

  const distrib = await runDistribuirHumano(env, {
    telefone: d.phone,
    id_lead: d.leadId,
    motivo: 'matricula_pos_form',
  })
  const sent = await sendLeadWhatsApp(d, buildConsultorCursoReply(curso))
  await setInscricaoStatus(d.phone, d.leadId, INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR)
  return {
    ok: Boolean(distrib?.ok) && (sent.sent || sent.ok),
    action: 'distribuir_consultor',
    consultor: distrib?.consultor,
    warnings: distrib?.warnings,
  }
}

async function handleFlushEnviarForm(d) {
  const out = await flushLeadAgent(d, 'Quero fazer minha inscrição')
  return { ok: Boolean(out?.ok && out?.reply), action: 'flush_enviar_form', reply: out?.reply?.slice(0, 80) }
}

async function retryCaptacaoLead(d) {
  const snapRes = await fetchLeadFormSnapshot(env, d.leadId).catch(() => null)
  const cursoCheck = await analyzeCursoInscricaoSnapshot(snapRes?.snapshot || {}, env)
  if (!cursoCheck.ok) {
    return handleDistribuirConsultor(d)
  }
  const res = await executeCaptacaoAfterFormResolved(env, {
    telefone: d.phone,
    idLead: d.leadId,
    executionId: generateExecutionId(),
    pushName: '',
  })
  const ok = res?.ok === true || res?.matriculaOk === true
  return { ok, action: 'retry_captacao', detail: res?.ctxForm || res?.reply?.slice(0, 120) }
}

async function handleLead(d) {
  if (!d.phone) return { ok: false, action: d.action, reason: 'sem_telefone' }

  switch (d.action) {
    case 'sync_status_aceite':
      return handleSyncStatusAceite(d)
    case 'iniciar_fluxo_inscricao':
      return handleIniciarFluxoInscricao(d)
    case 'flush_agente_pedir_polo':
      return handlePoloPreForm(d)
    case 'atender_distribuir_consultor':
      return handleDistribuirConsultor(d)
    case 'flush_agente_enviar_form':
      return handleFlushEnviarForm(d)
    case 'retry_captacao':
    case 'retry_captacao_cpf_fix':
    case 'form_preenchido_aguardando_captacao':
    case 'form_preenchido_sem_captacao':
      return retryCaptacaoLead(d)
    default:
      return { ok: true, action: 'skip', reason: 'nenhuma_acao' }
  }
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
  const action = actionForBucket(bucket, row)
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
console.log(`mode=${apply ? 'APPLY' : 'DRY-RUN'} handle=${handleAll} retryCaptacao=${retryCaptacao}\n`)

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

if (!apply) {
  console.log('\nRode com --apply --handle para atender casos pendentes.')
  console.log('Rode com --apply --retry-captacao para só reprocessar captação.')
  process.exit(0)
}

const ACTIONABLE = new Set([
  'sync_status_aceite',
  'iniciar_fluxo_inscricao',
  'flush_agente_pedir_polo',
  'atender_distribuir_consultor',
  'flush_agente_enviar_form',
  'retry_captacao',
  'retry_captacao_cpf_fix',
  'form_preenchido_aguardando_captacao',
  'form_preenchido_sem_captacao',
])

const toRun = details.filter((d) => {
  if (!ACTIONABLE.has(d.action)) return false
  if (handleAll) return true
  if (retryCaptacao) {
    return ['retry_captacao', 'retry_captacao_cpf_fix', 'form_preenchido_aguardando_captacao', 'form_preenchido_sem_captacao'].includes(d.action)
  }
  return false
})

if (!toRun.length) {
  console.log('\nNenhuma ação elegível para os flags informados.')
  process.exit(0)
}

let ok = 0
let fail = 0
for (const d of toRun) {
  console.log(`\n>> ${d.action} lead=${d.leadId} bucket=${d.bucket}`)
  try {
    const res = await handleLead(d)
    if (res?.ok) {
      console.log('   OK', res.action, res.detail || res.reply || res.consultor || '')
      ok += 1
    } else {
      console.log('   FALHA', res?.action, res?.reason || res?.detail || res)
      fail += 1
    }
  } catch (err) {
    console.error('   ERRO', err?.message || err)
    fail += 1
  }
  await new Promise((r) => setTimeout(r, INTER_LEAD_MS))
}

console.log(`\nAtendimento: ${ok} ok, ${fail} falha`)
process.exit(fail > 0 ? 1 : 0)
