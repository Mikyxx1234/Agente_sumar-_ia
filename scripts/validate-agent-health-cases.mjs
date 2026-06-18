/**
 * Casos de regressão de saúde do agente (sem WhatsApp).
 * Uso: node scripts/validate-agent-health-cases.mjs
 */
import { detectNivel, isNivelCorrectionMessage } from '../libShared/gradeNivelHeuristics.js'
import { findGradeRow } from '../libShared/gradeCurricularPdfService.js'
import {
  runEnviarGradePdf,
  tryHandleGradePdfRequest,
} from '../server/gradeCurricularActionTools.js'

const env = { GRADE_PDF_AUTO_ENABLED: 'true' }

const cases = []

function test(name, fn) {
  cases.push({ name, fn })
}

test('Edilson: tecnologia logística → grad', () => {
  return detectNivel({ userMessage: 'Grade curricular do curso tecnologia em logística?' }) === 'grad'
})

test('Edilson: não é pós → grad', () => {
  return detectNivel({ userMessage: 'Não é pós, é graduação' }) === 'grad'
})

test('findGradeRow logística → grad (não MBA)', () => {
  const row = findGradeRow({ curso: 'tecnologia em logística', nivel: 'grad' })
  return row?.nivel === 'grad' && /log/i.test(row?.nome || row?.id || '')
})

test('Márcia: preço bloqueia enviar_grade_pdf', async () => {
  const r = await runEnviarGradePdf(env, { telefone: '5511000000000', curso: 'Alfabetização' }, {
    userMessage: 'Oi qual valor do curso?',
    telefone: '5511000000000',
    historyMessages: [],
  })
  return r.code === 'GRADE_BLOCKED_PRICE_QUESTION'
})

test('Genérico: auto-send null sem curso', async () => {
  const r = await tryHandleGradePdfRequest(env, {
    userMessage: 'Me passa a grade curricular',
    telefone: '5511000000001',
    historyMessages: [],
    executionId: 'test',
    model: 'test',
  })
  return r === null
})

test('Correção nível: auto-send null', async () => {
  const r = await tryHandleGradePdfRequest(env, {
    userMessage: 'Não é pós, é graduação',
    telefone: '5511000000002',
    historyMessages: [{ role: 'user', content: 'Grade de logística' }],
    executionId: 'test',
    model: 'test',
  })
  return r === null
})

test('isNivelCorrectionMessage detecta negação pós', () => {
  return isNivelCorrectionMessage('Não é pós, é graduação')
})

let failed = 0
for (const c of cases) {
  try {
    const ok = Boolean(await c.fn())
    console.log(`${ok ? 'OK' : 'FAIL'} — ${c.name}`)
    if (!ok) failed++
  } catch (err) {
    console.log(`FAIL — ${c.name} (${err.message})`)
    failed++
  }
}
process.exit(failed > 0 ? 1 : 0)
