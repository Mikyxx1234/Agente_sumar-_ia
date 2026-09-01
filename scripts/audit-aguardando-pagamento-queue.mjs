/**
 * Audita fila "Aguardando pagamento" (106426128) — pipeline Agente Sumaré (13756724).
 * Leads sem conversa iniciada recebem template BV_sumare_aguard_PGT (--apply).
 *
 *   node scripts/audit-aguardando-pagamento-queue.mjs
 *   node scripts/audit-aguardando-pagamento-queue.mjs --sync
 *   node scripts/audit-aguardando-pagamento-queue.mjs --apply
 *   node scripts/audit-aguardando-pagamento-queue.mjs --sync --apply
 *   node scripts/audit-aguardando-pagamento-queue.mjs --apply --limit 10
 */
import fs from 'node:fs'
import { listLeadsByStatus, bulkGetContactsByIds, extractContactPhone, listLeadNotes, createLeadNote } from '../server/kommoClient.js'
import { resolvePosMatriculaTarget } from '../server/inscricaoAceitePagamentoFlow.js'
import { fetchDadosClienteByTelefone, ensureDadosClienteRow, updateDadosCliente } from '../server/dadosClienteStore.js'
import { fetchRecentChatRows } from '../server/historyStore.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'
import { parseGerarCandidatoPayload } from '../libShared/captacaoGerarOutcome.js'
import { isApiSumareOrigemSnapshot } from '../libShared/apiSumareOrigemHeuristics.js'
import { mirrorKommoCardToDadosCliente } from '../server/kommoCardMirror.js'
import { fetchLeadFormSnapshot } from '../server/inscricaoKommoFields.js'
import { resolvePoloFromKommoSnapshot } from '../libShared/sumarePoloCatalog.js'
import {
  buildGerarCandidatoQueryAsync,
  consultarStatusCandidato,
  extractCandidatoId,
  extractCandidatoStatusString,
  gerarCandidatoIngresso,
  isSumareCaptacaoEnabled,
  normalizeCpf,
  resolvePortalUrlForCandidato,
} from '../server/sumareCaptacaoClient.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'

const env = { ...process.env }
const envFile = process.env.ENV_FILE || '.env'
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
const sync = args.includes('--sync')
const limit = Number(args.find((a, i) => args[i - 1] === '--limit') || 0) || 0

const TEMPLATE_NAMES = String(
  env.WHATSAPP_TEMPLATE_AGUARD_PGT || 'bv_sumare_aguard_pgt_eggau9,bv_sumare_aguard_pgt,BV_sumare_aguard_PGT',
)
  .split(/[,;]+/)
  .map((s) => s.trim())
  .filter(Boolean)
const TEMPLATE_LANG = String(env.WHATSAPP_TEMPLATE_AGUARD_PGT_LANG || 'pt_BR').trim()
const TEMPLATE_KOMMO_ID = 48329
const INTER_SEND_MS = 2000

const SELECT =
  'telefone,inscricao_form_status,atendimento_ia,captacao_candidato_id,captacao_contrato_link,captacao_contrato_link_at,captacao_comprovante_at,captacao_curso_nome,captacao_curso_codigo,polo_inscricao_escolhido,captacao_unidade,inscricao_form_recebido_at,id_lead'

const { pipelineId, statusId } = resolvePosMatriculaTarget(env)

const EX_RE = /\s-\sEX-\d{6}-\d{4}-\d{3}/
const SKIP_USER =
  /^\[scheduler\]|^Candidato entrou|^Encaminhamento automático|^Retomada manual|^Nome da integração|^Salesbot|^O valor do campo|^Inscrição Sumaré|^Formulario_Sum|^Perfeito! Identificamos|^Ótimo! Sua inscrição|^Template WhatsApp/i
const TEMPLATE_SENT_RE = /BV_sumare_aguard_PGT|bv_sumare_aguard_pgt|aguard_PGT/i

function contactFirstName(name) {
  const n = String(name || '').trim()
  if (!n || /^Lead\s*#/i.test(n)) return 'candidato'
  const first = n.split(/\s+/)[0]
  return first || 'candidato'
}

function isRealUserText(text) {
  const t = String(text || '').trim()
  if (!t || t.length < 2) return false
  if (SKIP_USER.test(t)) return false
  if (EX_RE.test(t)) return false
  return true
}

function classifyData(row, phone) {
  if (!phone) return { bucket: 'sem_telefone', detail: 'sem telefone no Kommo' }
  if (!row) return { bucket: 'sem_dados_supabase', detail: 'linha ausente em dados_cliente' }

  const status = String(row.inscricao_form_status || '').trim()
  const ia = String(row.atendimento_ia || '').trim().toLowerCase()
  const candidato = String(row.captacao_candidato_id || '').trim()
  const comprovanteAt = row.captacao_comprovante_at
  const issues = []

  if (comprovanteAt) {
    if (status !== INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO) issues.push(`status=${status || 'null'}`)
    if (ia !== 'pause') issues.push(`ia=${ia || 'null'}`)
    if (!candidato) issues.push('sem_candidato')
    if (!issues.length) {
      return { bucket: 'ok_dados', detail: 'comprovante registrado, IA pausada, candidato OK' }
    }
    return { bucket: 'desalinhado', detail: issues.join('; ') }
  }

  if (!candidato) issues.push('sem_candidato')
  if (status !== INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) {
    issues.push(`status=${status || 'null'}`)
  }
  if (ia === 'pause') issues.push('ia=pause_sem_comprovante')

  if (!issues.length) {
    return { bucket: 'ok_dados', detail: 'candidato OK, aguardando pagamento/comprovante' }
  }
  return { bucket: 'desalinhado', detail: issues.join('; ') }
}

async function lookupCandidatoFromSnapshot(snapshot, phone) {
  if (!isSumareCaptacaoEnabled(env)) return { ok: false, reason: 'captacao_disabled' }
  const cpf = normalizeCpf(snapshot?.cpf)
  if (!cpf) return { ok: false, reason: 'sem_cpf' }
  const params = await buildGerarCandidatoQueryAsync({ ...snapshot, cpf }, phone, env)
  const gerar = await gerarCandidatoIngresso(env, params)
  if (!gerar.ok) return { ok: false, reason: 'gerar_falhou', error: gerar.error || gerar.raw }
  const parsed = parseGerarCandidatoPayload(gerar.data)
  const candidatoId = parsed?.candidatoId || extractCandidatoId(gerar.data)
  if (!candidatoId) return { ok: false, reason: 'candidato_nao_encontrado' }
  const statusRes = await consultarStatusCandidato(env, candidatoId)
  const statusStr = extractCandidatoStatusString(statusRes.data)
  const portal = resolvePortalUrlForCandidato(env, candidatoId, statusStr, { cpf })
  return { ok: true, candidatoId: String(candidatoId), portalUrl: portal.url || null }
}

async function syncLeadSupabase(r) {
  if (!r.phone) return { ok: false, action: 'skip_sem_telefone' }

  await ensureDadosClienteRow(env, {
    telefone: r.phone,
    idLead: r.leadId,
    fields: { id_lead: r.leadId, teste_ab: 'IA' },
  })
  await mirrorKommoCardToDadosCliente(env, { telefone: r.phone, leadId: r.leadId, force: true }).catch(() => {})

  const snapRes = await fetchLeadFormSnapshot(env, r.leadId).catch(() => null)
  const snapshot = snapRes?.snapshot || {}
  let row = await fetchDadosClienteByTelefone(env, r.phone, SELECT).catch(() => null)

  const fields = { id_lead: r.leadId }
  const actions = []

  const poloResolved = resolvePoloFromKommoSnapshot(snapshot, env)
  if (poloResolved?.polo && !row?.polo_inscricao_escolhido) {
    fields.polo_inscricao_escolhido = poloResolved.polo.nome
    fields.captacao_unidade = poloResolved.unidade
    actions.push('polo_kommo')
  }

  const cursoNome = String(snapshot.curso_inscricao || row?.captacao_curso_nome || '').trim()
  if (cursoNome && !row?.captacao_curso_nome) {
    fields.captacao_curso_nome = cursoNome
    fields.captacao_curso_codigo = snapshot.curso_inscricao || cursoNome
    actions.push('curso_kommo')
  }

  let candidatoId = String(row?.captacao_candidato_id || '').trim()
  let portalUrl = String(row?.captacao_contrato_link || '').trim()

  if (!candidatoId && isApiSumareOrigemSnapshot(snapshot)) {
    const lookup = await lookupCandidatoFromSnapshot(snapshot, r.phone)
    if (lookup.ok) {
      candidatoId = lookup.candidatoId
      portalUrl = lookup.portalUrl || portalUrl
      fields.captacao_candidato_id = candidatoId
      if (portalUrl) fields.captacao_contrato_link = portalUrl
      actions.push('api_candidato')
    } else {
      actions.push(`api_skip_${lookup.reason}`)
    }
  }

  if (row?.captacao_comprovante_at) {
    fields.inscricao_form_status = INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO
    fields.atendimento_ia = 'pause'
    actions.push('status_comprovante')
  } else if (candidatoId || row?.captacao_candidato_id) {
    fields.inscricao_form_status = INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
    fields.atendimento_ia = null
    if (!row?.inscricao_form_recebido_at) {
      fields.inscricao_form_recebido_at = new Date().toISOString()
    }
    actions.push('status_aguardando_aceite')
  } else if (portalUrl || row?.captacao_contrato_link) {
    fields.inscricao_form_status = INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
    fields.atendimento_ia = null
    actions.push('status_aguardando_link')
  }

  if (Object.keys(fields).length <= 1 && !actions.length) {
    return { ok: true, action: 'nada_a_alterar' }
  }

  await updateDadosCliente(env, { telefone: r.phone, fields }).catch(() => null)
  row = await fetchDadosClienteByTelefone(env, r.phone, SELECT).catch(() => null)
  const dataClass = classifyData(row, r.phone)
  return {
    ok: true,
    action: actions.join('+') || 'atualizado',
    dataBucket: dataClass.bucket,
    dataDetail: dataClass.detail,
    candidato: row?.captacao_candidato_id ?? null,
  }
}

function classifyConversation({ histRows, notes }) {
  for (const row of histRows || []) {
    if (isRealUserText(row?.user_message)) {
      return { hasConversation: true, reason: 'historico_user' }
    }
  }
  for (const n of notes || []) {
    const t = String(n?.params?.text || n?.params?.message || '').trim()
    if (!t) continue
    if (TEMPLATE_SENT_RE.test(t)) {
      return { hasConversation: false, templateAlreadySent: true, reason: 'template_ja_enviado' }
    }
    const type = String(n?.note_type || '').toLowerCase()
    if (type === 'sms_out' || type === 'outgoing_chat_message') continue
    if (EX_RE.test(t)) return { hasConversation: true, reason: 'nota_agente' }
    if (/^\[IA\]|Resposta bloqueada/i.test(t)) continue
    if (SKIP_USER.test(t)) continue
    if (t.length >= 3) return { hasConversation: true, reason: 'nota_inbound' }
  }
  return { hasConversation: false, reason: 'sem_mensagens' }
}

function buildTemplateComponents(contactName) {
  return [
    {
      type: 'body',
      parameters: [{ type: 'text', text: contactFirstName(contactName) }],
    },
  ]
}

async function sendEvolutionTemplateFlat(recipient, templateName, components) {
  const url = String(env.EVOLUTION_API_URL || '').replace(/\/$/, '')
  const apiKey = env.EVOLUTION_API_KEY || ''
  const instance = env.EVOLUTION_INSTANCE || env.EVOLUTION_INSTANCE_NAME || ''
  if (!url || !apiKey || !instance) return { ok: false, code: 'EVOLUTION_NOT_CONFIGURED' }

  const res = await fetch(`${url}/message/sendTemplate/${encodeURIComponent(instance)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({
      number: recipient,
      name: templateName,
      language: TEMPLATE_LANG,
      components,
    }),
  })
  const raw = await res.text()
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    return { ok: false, channel: 'evolution', template: templateName, error: raw.slice(0, 400) }
  }
  return {
    ok: true,
    channel: 'evolution',
    template: templateName,
    messageId: data?.key?.id || data?.message?.key?.id || null,
  }
}

async function sendCloudTemplate(recipient, templateName, components) {
  if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, code: 'WHATSAPP_NOT_CONFIGURED' }
  }
  const apiVersion = env.WHATSAPP_API_VERSION || 'v19.0'
  const url = `https://graph.facebook.com/${apiVersion}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: TEMPLATE_LANG },
        components,
      },
    }),
  })
  const raw = await res.text()
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    return { ok: false, channel: 'cloud', template: templateName, error: raw.slice(0, 400) }
  }
  return {
    ok: true,
    channel: 'cloud',
    template: templateName,
    messageId: data?.messages?.[0]?.id || null,
  }
}

async function sendAguardPagamentoTemplate({ phone, contactName, leadId }) {
  const recipient = String(phone || '').replace(/\D/g, '')
  if (!recipient) return { ok: false, error: 'telefone vazio' }

  const components = buildTemplateComponents(contactName)
  const executionId = generateExecutionId()
  let result = null

  for (const templateName of TEMPLATE_NAMES) {
    result = await sendCloudTemplate(recipient, templateName, components)
    if (result.ok) break
    const evo = await sendEvolutionTemplateFlat(recipient, templateName, components)
    if (evo.ok) {
      result = evo
      break
    }
    result = evo.ok ? evo : result || evo
  }

  if (result?.ok && leadId) {
    const noteText =
      `Template WhatsApp "${result.template}" (Kommo #${TEMPLATE_KOMMO_ID}) enviado — aguardando pagamento — ${executionId}`
    await createLeadNote(env, leadId, noteText).catch(() => {})
    result.executionId = executionId
  }
  return result || { ok: false, error: 'WhatsApp não configurado' }
}

async function loadQueue(pid, sid) {
  const listing = await listLeadsByStatus(env, { pipelineId: pid, statusId: sid, limit: 250, maxPages: 10 })
  if (!listing.ok) throw new Error(listing.error || listing.code || 'listLeadsByStatus failed')
  return listing.leads || []
}

async function enrichLeads(leads) {
  const contactIds = [
    ...new Set(leads.flatMap((l) => (l._embedded?.contacts || []).map((c) => c.id)).filter(Boolean)),
  ]
  const bulk = await bulkGetContactsByIds(env, contactIds)
  const byId = new Map((bulk.contacts || []).map((c) => [Number(c.id), c]))

  const rows = []
  let i = 0
  for (const lead of leads) {
    const leadId = Number(lead.id)
    const name = String(lead.name || '').trim() || '(sem nome)'
    let phone = null
    for (const c of lead._embedded?.contacts || []) {
      phone = extractContactPhone(byId.get(Number(c.id)))
      if (phone) break
    }

    let row = null
    if (phone) row = await fetchDadosClienteByTelefone(env, phone, SELECT).catch(() => null)

    const dataClass = classifyData(row, phone)
    const histRows = phone ? await fetchRecentChatRows(env, phone, 15).catch(() => []) : []
    const notesRes = await listLeadNotes(env, leadId, { limit: 15 }).catch(() => ({ notes: [] }))
    const conv = classifyConversation({ histRows, notes: notesRes.notes || [] })

    let convBucket = 'conversa_iniciada'
    let action = 'nenhuma'
    if (!phone) {
      convBucket = 'sem_telefone'
    } else if (conv.templateAlreadySent) {
      convBucket = 'template_ja_enviado'
    } else if (!conv.hasConversation) {
      convBucket = 'sem_conversa'
      action = 'enviar_template_aguard_pgt'
    }

    rows.push({
      leadId,
      name,
      phone: phone || null,
      contactName: contactFirstName(name),
      dataBucket: dataClass.bucket,
      dataDetail: dataClass.detail,
      convBucket,
      convReason: conv.reason,
      action,
      inscricaoStatus: row?.inscricao_form_status ?? null,
      ia: row?.atendimento_ia ?? null,
      candidato: row?.captacao_candidato_id ?? null,
      comprovanteAt: row?.captacao_comprovante_at ?? null,
      curso: row?.captacao_curso_nome ?? null,
      histUserMsgs: (histRows || []).filter((r) => isRealUserText(r?.user_message)).length,
    })

    i++
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 200))
  }
  return rows
}

function summarize(rows, key) {
  const buckets = {}
  for (const r of rows) buckets[r[key]] = (buckets[r[key]] || 0) + 1
  return buckets
}

console.log(`# Fila Aguardando pagamento — pipeline ${pipelineId} status ${statusId}`)
console.log(
  `mode=${apply ? 'APPLY' : 'AUDIT'} sync=${sync} templates=${TEMPLATE_NAMES.join('|')} kommoTemplateId=${TEMPLATE_KOMMO_ID}\n`,
)

const pagamentoLeads = await loadQueue(pipelineId, statusId)
let pagamentoRows = await enrichLeads(pagamentoLeads)

const syncStats = { ok: 0, fail: 0, skip: 0 }
if (sync) {
  const syncTargets = pagamentoRows.filter(
    (r) => r.dataBucket === 'desalinhado' || r.dataBucket === 'sem_dados_supabase',
  )
  const syncWork = limit > 0 ? syncTargets.slice(0, limit) : syncTargets
  console.log(`\n>> Sincronizando Supabase/Kommo para ${syncWork.length} lead(s)\n`)
  for (const r of syncWork) {
    console.log(`>> sync lead=${r.leadId} ${r.name}`)
    try {
      const out = await syncLeadSupabase(r)
      if (out.ok) {
        console.log(`   OK ${out.action} bucket=${out.dataBucket || 'n/a'} candidato=${out.candidato || 'n/a'}`)
        syncStats.ok++
      } else {
        console.log(`   SKIP ${out.action}`)
        syncStats.skip++
      }
    } catch (e) {
      console.log(`   FAIL ${e?.message || e}`)
      syncStats.fail++
    }
    await new Promise((res) => setTimeout(res, 400))
  }
  console.log(`\nSync: ${syncStats.ok} ok, ${syncStats.fail} falha, ${syncStats.skip} skip`)
  pagamentoRows = await enrichLeads(pagamentoLeads)
}
const dataBuckets = summarize(pagamentoRows, 'dataBucket')
const convBuckets = summarize(pagamentoRows, 'convBucket')

console.log(`Total na fila Aguardando pagamento: ${pagamentoRows.length}`)
console.log('Resumo dados:', dataBuckets)
console.log('Resumo conversa:', convBuckets)

const semConversa = pagamentoRows.filter((r) => r.convBucket === 'sem_conversa')
const templateTargets = limit > 0 ? semConversa.slice(0, limit) : semConversa

if (semConversa.length) {
  console.log(`\n## Sem conversa iniciada (${semConversa.length}) — template ${TEMPLATE_NAMES[0]}\n`)
  for (const r of semConversa) {
    console.log(
      `- #${r.leadId} ${r.name} | tel=${r.phone || 'n/a'} | dados=${r.dataBucket}` +
        (r.curso ? ` | curso=${r.curso}` : '') +
        ` | candidato=${r.candidato || 'n/a'}`,
    )
  }
}

const conversaOk = pagamentoRows.filter((r) => r.convBucket === 'conversa_iniciada')
if (conversaOk.length) {
  console.log(`\n## Com conversa iniciada (${conversaOk.length})\n`)
  for (const r of conversaOk.slice(0, 15)) {
    console.log(`- #${r.leadId} ${r.name} | ${r.convReason} | histUser=${r.histUserMsgs}`)
  }
  if (conversaOk.length > 15) console.log(`  … +${conversaOk.length - 15} leads`)
}

const problemRows = pagamentoRows.filter((r) => r.dataBucket === 'desalinhado' || r.dataBucket === 'sem_dados_supabase')
if (problemRows.length) {
  console.log('\n## Desalinhamento Supabase/Kommo\n')
  for (const r of problemRows) {
    console.log(`- #${r.leadId} ${r.name} | ${r.dataBucket} | ${r.dataDetail}`)
  }
}

const stats = { sent: 0, fail: 0, skip: 0 }

if (apply && templateTargets.length) {
  console.log(`\n>> Enviando template para ${templateTargets.length} lead(s)\n`)
  for (const r of templateTargets) {
    if (!r.phone) {
      stats.skip++
      continue
    }
    console.log(`>> lead=${r.leadId} ${r.name} nome=${r.contactName}`)
    const out = await sendAguardPagamentoTemplate({
      phone: r.phone,
      contactName: r.name,
      leadId: r.leadId,
    })
    if (out.ok) {
      console.log(`   OK channel=${out.channel} msg=${out.messageId || 'n/a'}`)
      stats.sent++
    } else {
      console.log(`   FAIL ${out.error || out.code || 'unknown'}`)
      stats.fail++
    }
    await new Promise((res) => setTimeout(res, INTER_SEND_MS))
  }
  console.log('\nAtendimento template:', `${stats.sent} ok, ${stats.fail} falha, ${stats.skip} skip`)
}

console.log('\n---')
console.log(
  JSON.stringify(
    {
      pagamentoTotal: pagamentoRows.length,
      dataBuckets,
      convBuckets,
      semConversa: semConversa.length,
      apply,
      sync,
      syncStats: sync ? syncStats : null,
      templateStats: apply ? stats : null,
    },
    null,
    2,
  ),
)
