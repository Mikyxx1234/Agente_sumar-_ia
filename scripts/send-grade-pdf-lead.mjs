#!/usr/bin/env node
/**
 * Gera PDF da grade curricular e envia ao lead via WhatsApp.
 *
 * Uso:
 *   node scripts/send-grade-pdf-lead.mjs --lead-id 23841399 --curso pedagogia --modalidade semipresencial
 *   node scripts/send-grade-pdf-lead.mjs --lead-id 23841399 --apply
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLeadSummary } from '../server/kommoClient.js'
import { generateGradePdf } from '../libShared/generateGradePdf.js'
import { sendGradePdfToLead } from '../server/evolution/evolutionSendMedia.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const GRADE_JSON = path.join(ROOT, 'data/grade-curricular-sumare.json')
const OUT_DIR = path.join(ROOT, 'data/pdfs')

const env = { ...process.env }
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const args = process.argv.slice(2)
const dryRun = !args.includes('--apply')
const leadId = Number(args.find((a, i) => args[i - 1] === '--lead-id') || '')
const cursoId = String(args.find((a, i) => args[i - 1] === '--curso') || 'pedagogia').toLowerCase()
const modalidadeArg = String(args.find((a, i) => args[i - 1] === '--modalidade') || 'semipresencial').toLowerCase()

if (!Number.isFinite(leadId) || leadId <= 0) {
  console.error(
    'Uso: node scripts/send-grade-pdf-lead.mjs --lead-id <id> [--curso pedagogia] [--modalidade semipresencial|ead] [--apply]',
  )
  process.exit(1)
}

function modLabelFromArg(arg) {
  if (arg === 'ead') return 'EAD'
  if (arg.startsWith('semi')) return 'Semipresencial'
  if (arg.startsWith('pres')) return 'Presencial'
  return 'Semipresencial'
}

function loadGrade(curso, modLabel) {
  const rows = JSON.parse(fs.readFileSync(GRADE_JSON, 'utf8'))
  const row = rows.find(
    (r) => r.id === curso && String(r.modalidade || '').toLowerCase() === modLabel.toLowerCase(),
  )
  if (!row?.pages?.length) throw new Error(`Grade não encontrada: ${curso} / ${modLabel}`)
  const disciplinas = row.pages.flatMap((p) => p.disciplinas || []).filter(Boolean)
  if (!disciplinas.length) throw new Error(`Grade vazia: ${curso} / ${modLabel}`)
  return { row, disciplinas }
}

function firstName(name) {
  const raw = String(name || '').trim()
  if (!raw || /^lead\s*#/i.test(raw)) return 'Olá'
  return raw.split(/\s+/)[0]
}

async function main() {
  const modLabel = modLabelFromArg(modalidadeArg)
  const { row, disciplinas } = loadGrade(cursoId, modLabel)
  const investimento =
    modLabel === 'Semipresencial' ? 'a partir de R$ 117,00/mês' : modLabel === 'EAD' ? 'a partir de R$ 97,00/mês' : ''

  const summary = await getLeadSummary(env, leadId)
  if (!summary.ok || !summary.phone) {
    console.error('Lead inválido ou sem telefone:', summary.error || summary)
    process.exit(1)
  }

  const nome = firstName(summary.name)
  const pdfInput = {
    cursoNome: row.nome || 'Pedagogia',
    modalidade: modLabel,
    titulacao: 'Licenciatura',
    duracao: '8 semestres',
    investimento,
    codigo: row.codigo || '',
    intro: row.intro || '',
    disciplinas,
    url: row.url || 'https://sumare.edu.br',
  }

  const { buffer, fileName } = await generateGradePdf(pdfInput)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outPath = path.join(OUT_DIR, fileName)
  fs.writeFileSync(outPath, buffer)

  const introText =
    `Oi, ${nome}! Segue em anexo a *grade curricular* de *${pdfInput.cursoNome}* (${modLabel}) em PDF.\n\n` +
    `São *${disciplinas.length} disciplinas* — Licenciatura, 8 semestres${investimento ? `, ${investimento}` : ''}.\n\n` +
    `Abra o arquivo *${fileName}* para consultar a lista completa. Posso te ajudar com mais alguma dúvida?`

  console.log(`lead=${leadId} name=${summary.name} phone=${summary.phone}`)
  console.log(`curso=${cursoId} modalidade=${modLabel} disciplinas=${disciplinas.length}`)
  console.log(`pdf=${outPath} (${buffer.length} bytes)`)
  console.log(`mode=${dryRun ? 'dry-run' : 'apply'}`)
  console.log('--- intro ---')
  console.log(introText)
  console.log('---')

  if (dryRun) {
    console.log('[dry-run] PDF gerado localmente; nada enviado.')
    return
  }

  const res = await sendGradePdfToLead(env, {
    telefone: summary.phone,
    leadId,
    introText,
    pdfBuffer: buffer,
    fileName,
    caption: `Grade curricular — ${pdfInput.cursoNome} (${modLabel})`,
  })

  if (!res.ok) {
    console.error('Falha no envio:', res)
    process.exit(1)
  }

  console.log('Envio OK', res.channel || '', res.steps?.map((s) => s.step).join(' → '))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
