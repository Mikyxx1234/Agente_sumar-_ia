/**
 * Envia mensagem corretiva manual para um lead específico.
 *
 * Uso:
 *   node scripts/send-corrective-lead.mjs --lead-id 23843695 --dry-run
 *   node scripts/send-corrective-lead.mjs --lead-id 23843695 --apply
 *   node scripts/send-corrective-lead.mjs --topic pos-gratis --lead-id 23861891,23589423 --apply
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLeadSummary } from '../server/kommoClient.js'
import { sendMessageWithNote } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'
import { appendChatMemory, saveConversation } from '../server/historyStore.js'
import { formatPoloListaNumerada } from '../libShared/sumarePoloCatalog.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const args = process.argv.slice(2)
const topic = String(args.find((a, i) => args[i - 1] === '--topic') || 'vivian').toLowerCase()
const dryRun = !args.includes('--apply')
const delayMs = Number(args.find((a, i) => args[i - 1] === '--delay-ms') || 2500)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GRADE_JSON = path.join(__dirname, '../data/grade-curricular-sumare.json')

const modalidadeArg = String(args.find((a, i) => args[i - 1] === '--modalidade') || 'semipresencial').toLowerCase()
const leadIdArg = args.find((a, i) => args[i - 1] === '--lead-id') || ''
const leadIds = leadIdArg
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)

if (!leadIds.length) {
  console.error(
    'Uso: node scripts/send-corrective-lead.mjs --lead-id <id>[,id2,...] [--topic vivian|pos-gratis|pedagogia-curso|pedagogia-grade] [--modalidade ead|semipresencial] [--apply] [--delay-ms 2500]',
  )
  process.exit(1)
}

function displayFirstName(name, leadId) {
  const raw = String(name || '').trim()
  if (!raw || /^lead\s*#/i.test(raw)) return 'Olá'
  return raw.split(/\s+/)[0]
}

function loadPedagogiaGrade(modalidade = 'semipresencial') {
  const modLabel =
    modalidade === 'ead' ? 'EAD' : modalidade.startsWith('semi') ? 'Semipresencial' : 'Presencial'
  const rows = JSON.parse(fs.readFileSync(GRADE_JSON, 'utf8'))
  const row = rows.find(
    (r) => r.id === 'pedagogia' && String(r.modalidade || '').toLowerCase() === modLabel.toLowerCase(),
  )
  if (!row?.pages?.length) throw new Error(`Grade Pedagogia ${modLabel} não encontrada em ${GRADE_JSON}`)
  const disc = row.pages.flatMap((p) => p.disciplinas || []).filter(Boolean)
  return { modLabel, disc, intro: row.intro || '', codigo: row.codigo || '' }
}

function buildPedagogiaGradeMessage(firstName, modalidade = 'semipresencial') {
  const { modLabel, disc, codigo } = loadPedagogiaGrade(modalidade)
  const investimento = modLabel === 'Semipresencial' ? 'R$ 117,00/mês' : modLabel === 'EAD' ? 'R$ 97,00/mês' : 'consulte valores'
  const lista = disc.map((d, i) => `${i + 1}. ${d}`).join('\n')
  return (
    `Oi, ${firstName}! Conforme solicitado, segue a *grade curricular* de *Pedagogia* (${modLabel}):\n\n` +
    `*Pedagogia* — Licenciatura · ${modLabel}\n` +
    `*Duração:* 8 semestres\n` +
    `*Investimento:* a partir de ${investimento}\n` +
    `*Total de disciplinas:* ${disc.length}\n\n` +
    `*O que você vai aprender:*\n${lista}\n\n` +
    `Fonte oficial: sumare.edu.br · Código: ${codigo || 'PED_' + modLabel.slice(0, 4).toUpperCase()}\n\n` +
    `Em breve também enviaremos essa grade em PDF. Posso te ajudar com mais alguma dúvida ou seguir com a inscrição?`
  )
}

function buildMessage(topicName, firstName) {
  if (topicName === 'pedagogia-grade') {
    return buildPedagogiaGradeMessage(firstName, modalidadeArg)
  }

  if (topicName === 'pos-gratis') {
    return (
      `Oi, ${firstName}! Peço desculpas pela resposta anterior sobre a promoção de Pós-Graduação.\n\n` +
      `Sim, existe a promoção de *Pós-Graduação 100% gratuita* ao final do curso de graduação, conforme campanha vigente da Faculdade Sumaré.\n\n` +
      `*Como funciona:* após você concluir a graduação, você tem *30 dias* para entrar em contato com a *Central da Faculdade Sumaré* e solicitar a sua Pós-Graduação gratuita.\n\n` +
      `Posso te ajudar com mais alguma dúvida ou seguir com a inscrição?`
    )
  }

  if (topicName === 'pedagogia-curso') {
    return (
      `Oi, ${firstName}! Peço desculpas pelo encaminhamento anterior — vou te passar as informações sobre *Pedagogia*:\n\n` +
      `*Curso:* Graduação em Pedagogia (Licenciatura)\n` +
      `*Duração:* 8 semestres\n` +
      `*Modalidade:* *Semipresencial* — a maior parte do estudo é a distância, com encontros presenciais agendados na nossa *Central em Pinheiros* (Rua Alegrete, 89, Sumaré, São Paulo/SP).\n\n` +
      `Sobre sua dúvida do MEC e 100% online: a Pedagogia na Sumaré é ofertada em *Semipresencial*, não em EAD 100% online, conforme a oferta oficial do curso e as exigências da formação em Licenciatura.\n\n` +
      `*Valores:* mensalidade promocional de *R$ 117,00* (preço cheio R$ 390,00). A taxa de matrícula é a *primeira mensalidade*, no mesmo valor.\n\n` +
      `*Como fazer a matrícula:* quando você quiser seguir, envio o *formulário de inscrição* aqui no WhatsApp — é rápido e você preenche os dados básicos por aqui mesmo.\n\n` +
      `Quer que eu te envie o formulário para começar a inscrição em Pedagogia?`
    )
  }

  const poloList = formatPoloListaNumerada()
  return (
    `Oi, ${firstName}! Peço desculpas pela resposta anterior — vou esclarecer suas dúvidas:\n\n` +
    `*1. Mensalidade e desconto:* Pagando no *1º dia de cada mês*, o desconto máximo (70%) é aplicado na mensalidade daquele mês. ` +
    `Ou seja, não é só na primeira parcela — mantendo o pagamento no dia 1, o benefício se repete todo mês (ex.: R$ 97, conforme o valor promocional do curso).\n\n` +
    `*2. Taxa de matrícula:* Sim, há taxa de matrícula — ela *é a primeira mensalidade*, no mesmo valor promocional informado (R$ 97).\n\n` +
    `*3. Polos:* Por este número de contato atendemos os seguintes polos:\n\n` +
    `${poloList}\n\n` +
    `Sim, os cursos são *100% EAD*; o polo é o ponto de apoio presencial.\n\n` +
    `Posso te ajudar com mais alguma dúvida ou seguir com a inscrição?`
  )
}

async function sendToLead(leadId) {
  const summary = await getLeadSummary(env, leadId)
  if (!summary.ok || !summary.phone) {
    console.error(`lead=${leadId} FALHA:`, summary.error || 'telefone ausente')
    return false
  }

  const firstName = displayFirstName(summary.name, leadId)
  const text = buildMessage(topic, firstName)

  console.log(`\nlead=${leadId} name=${summary.name} phone=${summary.phone}`)
  console.log(`topic=${topic} mode=${dryRun ? 'dry-run' : 'apply'}`)
  console.log('---')
  console.log(text)
  console.log('---')

  if (dryRun) return true

  const executionId = generateExecutionId()
  const sendRes = await sendMessageWithNote(env, {
    telefone: summary.phone,
    text,
    leadId,
    executionId,
  })

  if (!sendRes?.ok || sendRes.deduped) {
    console.error(`lead=${leadId} FALHA envio:`, sendRes)
    return false
  }

  await appendChatMemory(env, { telefone: summary.phone, userMessage: '', botMessage: text }).catch(() => {})
  await saveConversation(env, {
    telefone: summary.phone,
    userMessage: '',
    botMessage: text,
    messageType: 'corrective_reply',
    idLead: leadId,
  }).catch(() => {})

  console.log(`lead=${leadId} OK exec=${executionId}`)
  return true
}

let ok = 0
let fail = 0
for (let i = 0; i < leadIds.length; i++) {
  const sent = await sendToLead(leadIds[i])
  if (sent) ok++
  else fail++
  if (!dryRun && i < leadIds.length - 1) await new Promise((r) => setTimeout(r, delayMs))
}

console.log(`\nResumo: ${ok} ok, ${fail} falha(s)`)
if (fail > 0) process.exit(1)
