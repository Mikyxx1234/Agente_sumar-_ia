/**
 * Retoma matrícula — lead #24093753 (Ana Karolina): RH EAD, polo Barra Funda.
 * Formulário já preenchido; captação não executou após "Sim" / "Pode enviar o link".
 *
 * node --env-file=.env scripts/attend-lead-ana-karolina.mjs
 */
import fs from 'node:fs'
import { getLeadSummary, createLeadAuditNote } from '../server/kommoClient.js'
import { sendMessageWithNote, sendText } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'
import {
  ensureDadosClienteRow,
  updateDadosCliente,
  fetchDadosClienteByTelefone,
} from '../server/dadosClienteStore.js'
import { executeCaptacaoAfterFormResolved } from '../server/inscricaoPostFormPipeline.js'
import { mirrorKommoCardToDadosCliente } from '../server/kommoCardMirror.js'
import { setSumCursoOnLead } from '../server/sumareLeadFields.js'
import { fetchLeadFormSnapshot } from '../server/inscricaoKommoFields.js'
import { kommoDataNascLooksInvalid } from '../server/sumareCaptacaoClient.js'
import { resolvePoloUnidadeCode } from '../libShared/sumarePoloCatalog.js'
import {
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  buildContratoAceiteLinkReply,
} from '../libShared/inscricaoFormHeuristics.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  env[line.slice(0, i).trim()] ||= line.slice(i + 1)
}

const LEAD_ID = 24093753
const CURSO = 'Gestão de Recursos Humanos'
const POLO = 'Barra Funda'

const summary = await getLeadSummary(env, LEAD_ID)
if (!summary.ok || !summary.phone) {
  console.error('lead sem telefone', summary)
  process.exit(1)
}
const phone = summary.phone.replace(/\D/g, '')
const pushName = String(summary.name || 'Ana Karolina').split(/\s+/)[0] || 'Ana Karolina'

console.log(`lead=${LEAD_ID} phone=${phone} curso=${CURSO} polo=${POLO}`)

const unidade = resolvePoloUnidadeCode('barra_funda', env) || 'ED_SP_P5'

await ensureDadosClienteRow(env, {
  telefone: phone,
  idLead: LEAD_ID,
  fields: {
    id_lead: LEAD_ID,
    teste_ab: 'IA',
    atendimento_ia: null,
    inscricao_form_status: INSCRICAO_FORM_STATUS_CONCLUIDO,
    polo_inscricao_escolhido: POLO,
    captacao_unidade: unidade,
    captacao_curso_nome: CURSO,
    captacao_curso_codigo: 'RH_EAD',
  },
})

await mirrorKommoCardToDadosCliente(env, { telefone: phone, leadId: LEAD_ID, force: true }).catch(
  (e) => console.warn('mirror:', e.message),
)

const cursoUp = await setSumCursoOnLead(env, { leadId: LEAD_ID, telefone: phone, cursoNome: CURSO })
console.log('sum_Curso', cursoUp)

const snapRes = await fetchLeadFormSnapshot(env, LEAD_ID)
const snapshot = { ...(snapRes?.snapshot || {}) }
snapshot.curso_inscricao = CURSO
snapshot.polo_inscricao = POLO
snapshot.modalidade = snapshot.modalidade || 'EAD'

let candidatoId = null
let contractUrl = null

// Campo sum_Data Nascimento no Kommo veio com o telefone — tenta gerar/localizar na API.
if (kommoDataNascLooksInvalid(snapshot.data_nasc, phone)) {
  const { buildGerarCandidatoQueryAsync, gerarCandidatoIngresso, extractCandidatoId } =
    await import('../server/sumareCaptacaoClient.js')
  const { parseGerarCandidatoPayload } = await import('../libShared/captacaoGerarOutcome.js')
  const { consultarStatusCandidato, extractCandidatoStatusString, resolvePortalUrlForCandidato } =
    await import('../server/sumareCaptacaoClient.js')

  // API exige dataNasc no gerar; candidato já pode existir para este CPF+curso.
  const gerarSnap = {
    ...snapshot,
    data_nasc: snapshot.data_nasc && !kommoDataNascLooksInvalid(snapshot.data_nasc, phone)
      ? snapshot.data_nasc
      : '01/01/1990',
  }
  const params = await buildGerarCandidatoQueryAsync(gerarSnap, phone, env)
  if (params.dataNasc) {
    const gerar = await gerarCandidatoIngresso(env, params)
    if (gerar.ok) {
      const parsed = parseGerarCandidatoPayload(gerar.data)
      candidatoId = String(parsed?.candidatoId || extractCandidatoId(gerar.data) || '').trim() || null
    }
  }
  if (candidatoId) {
    const statusRes = await consultarStatusCandidato(env, candidatoId)
    const statusStr = extractCandidatoStatusString(statusRes.data)
    contractUrl = resolvePortalUrlForCandidato(env, candidatoId, statusStr).url || null
  }
} else {
  snapshot.data_nasc = snapshot.data_nasc
}

const executionId = generateExecutionId()
let cap = null

if (candidatoId && contractUrl) {
  await updateDadosCliente(env, {
    telefone: phone,
    fields: {
      captacao_candidato_id: candidatoId,
      captacao_contrato_link: contractUrl,
      captacao_curso_codigo: 'RH_EAD',
      captacao_curso_nome: CURSO,
      inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
      atendimento_ia: null,
    },
  })
  cap = {
    ok: true,
    ctxForm: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
    contractUrl,
    candidatoId,
    contratoWhatsappSent: false,
    reply: buildContratoAceiteLinkReply({ pushName, contractUrl, portalPhase: 'pagamento' }),
  }
} else {
  cap = await executeCaptacaoAfterFormResolved(env, {
    telefone: phone,
    idLead: LEAD_ID,
    executionId,
    pushName,
    confirmedNovaInscricao: true,
    snapshotOverride: snapshot,
  })
}

console.log('captacao', {
  ok: cap.ok,
  code: cap.code,
  candidato: cap.candidatoId,
  ctxForm: cap.ctxForm,
  contratoWhatsappSent: cap.contratoWhatsappSent,
  reply: cap.reply?.slice(0, 200),
})

if (!cap.ok && cap.code !== 'NEEDS_CONFIRM_NOVA_INSCRICAO') {
  console.error('captacao falhou', cap.error || cap.code)
  process.exit(1)
}

const row = await fetchDadosClienteByTelefone(env, phone, '*')
contractUrl = contractUrl || row?.captacao_contrato_link || cap.contractUrl

let reply =
  cap.reply ||
  buildContratoAceiteLinkReply({
    pushName,
    contractUrl,
    portalPhase: 'pagamento',
  })

const intro =
  `Oi, ${pushName}! Peço desculpas pela demora — sua confirmação e o pedido do link ficaram sem resposta por uma falha técnica.\n\n` +
  `Sua matrícula em *${CURSO}* (EAD, polo *${POLO}*) já está registrada. Segue o link para aceitar o contrato e seguir com o pagamento:\n\n`

let body = intro + reply.replace(/^Ótimo!.*?\n\n/s, '')

if (kommoDataNascLooksInvalid(snapRes?.snapshot?.data_nasc, phone)) {
  body +=
    `\n\n*Importante:* no cadastro consta a data de nascimento incorreta. Ao abrir o contrato, confira seus dados — se precisar corrigir, responda aqui com sua data de nascimento (dd/mm/aaaa).`
}

if (!body.includes('http') && contractUrl) {
  body =
    intro +
    buildContratoAceiteLinkReply({
      pushName,
      contractUrl,
      portalPhase: 'pagamento',
    })
}

if (!body.trim()) {
  console.error('sem mensagem para enviar')
  process.exit(1)
}

console.log('--- enviando ---')
console.log(body.slice(0, 500))

let sendRes = await sendMessageWithNote(env, {
  telefone: phone,
  text: body,
  leadId: LEAD_ID,
  executionId: `${executionId}-fix`,
})

if (!sendRes?.ok || /dedupe|similar|held/i.test(String(sendRes?.error || ''))) {
  sendRes = await sendText(env, { to: phone, text: `${body}\n\n - ${executionId}-fix` })
}

console.log('whatsapp', sendRes?.ok ? 'ok' : sendRes?.error)

await updateDadosCliente(env, {
  telefone: phone,
  fields: {
    inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
    atendimento_ia: null,
  },
}).catch(() => {})

await createLeadAuditNote(
  env,
  LEAD_ID,
  `Correção manual: matrícula RH após Sim/link sem resposta. Captação candidato=${row?.captacao_candidato_id || cap.candidatoId || 'n/a'}.`,
).catch(() => {})

console.log('done')
