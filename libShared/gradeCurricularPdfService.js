/**
 * Localiza grade curricular (grad + pós) nos JSONs scrapeados e gera/envia PDF.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateGradePdf } from './generateGradePdf.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const GRADE_JSON_BY_NIVEL = {
  grad: path.join(ROOT, 'data/grade-curricular-sumare.json'),
  pos: path.join(ROOT, 'data/grade-curricular-pos-sumare.json'),
}

const cache = new Map()

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function modLabelFromArg(arg) {
  if (!arg) return null
  const a = norm(arg)
  if (/\bead\b/.test(a)) return 'EAD'
  if (/hibr/.test(a)) return 'Híbrido'
  if (/semi/.test(a)) return 'Semipresencial'
  if (/pres/.test(a)) return 'Presencial'
  return null
}

function loadRows(nivel) {
  const key = nivel || 'all'
  if (cache.has(key)) return cache.get(key)
  const files = nivel ? [nivel] : ['pos', 'grad']
  const rows = []
  for (const n of files) {
    const p = GRADE_JSON_BY_NIVEL[n]
    if (!p || !fs.existsSync(p)) continue
    for (const row of JSON.parse(fs.readFileSync(p, 'utf8'))) {
      rows.push({ ...row, nivel: row.nivel || n })
    }
  }
  cache.set(key, rows)
  return rows
}

function tokens(s) {
  return norm(s)
    .split(' ')
    .filter((t) => t.length > 2 && !['curso', 'graduacao', 'pos', 'posgraduacao', 'mba', 'em'].includes(t))
}

function scoreRow(row, cursoNorm, modLabel) {
  const idNorm = norm(row.id)
  const nomeNorm = norm(row.nome)
  let score = 0
  if (cursoNorm && (idNorm.includes(cursoNorm) || cursoNorm.includes(idNorm))) score += 8
  if (cursoNorm && (nomeNorm.includes(cursoNorm) || cursoNorm.includes(nomeNorm))) score += 10
  const cursoTokens = tokens(cursoNorm)
  for (const t of cursoTokens) {
    if (idNorm.includes(t)) score += 3
    if (nomeNorm.includes(t)) score += 4
  }
  if (modLabel && norm(row.modalidade) === norm(modLabel)) score += 6
  const discCount = (row.pages || []).reduce((n, p) => n + (p.disciplinas?.length || 0), 0)
  if (discCount > 0) score += 1
  return score
}

/**
 * @param {{ curso: string, modalidade?: string|null, nivel?: 'grad'|'pos'|null }} input
 */
function inferNivelSearchOrder(cursoNorm, explicitNivel) {
  if (explicitNivel) return [explicitNivel]
  if (/\b(mba|pos\s*grad|especializa|lato\s+sensu)\b/.test(cursoNorm)) return ['pos']
  if (/\b(bacharel|licenciatura|tecnolog|gradua)\b/.test(cursoNorm)) return ['grad']
  return ['grad', 'pos']
}

export function findGradeRow(input) {
  const curso = String(input?.curso || '').trim()
  if (!curso) return null
  const cursoNorm = norm(curso)
  const modLabel = modLabelFromArg(input?.modalidade)
  const niveis = inferNivelSearchOrder(cursoNorm, input?.nivel || null)
  let best = null
  let bestScore = 0
  for (const n of niveis) {
    for (const row of loadRows(n)) {
      const s = scoreRow(row, cursoNorm, modLabel)
      if (s > bestScore) {
        bestScore = s
        best = row
      }
    }
  }
  return bestScore >= 4 ? best : null
}

/** Extrai o grau (bacharelado/licenciatura/tecnologo) do nome de um curso. */
export function grauFromCourseName(name) {
  const n = norm(name)
  if (/\blicenciatura\b/.test(n)) return 'licenciatura'
  if (/bacharel/.test(n)) return 'bacharelado'
  if (/tecnolog/.test(n)) return 'tecnologo'
  return null
}

/**
 * Lista os graus distintos disponíveis para um curso (ex.: Educação Física tem
 * Bacharelado + Licenciatura, com grades diferentes). Usado para desambiguar
 * antes de gerar o PDF e evitar enviar o grau errado.
 * @param {{ curso: string, nivel?: 'grad'|'pos'|null }} input
 * @returns {string[]}
 */
export function listGradeGrausForCurso({ curso, nivel } = {}) {
  const cursoNorm = norm(curso)
  if (!cursoNorm) return []
  const cursoTokens = tokens(cursoNorm).filter(
    (t) => !['bacharelado', 'bacharel', 'licenciatura', 'tecnologo', 'tecnologia'].includes(t),
  )
  if (!cursoTokens.length) return []
  const niveis = nivel ? [nivel] : ['grad', 'pos']
  const graus = new Set()
  for (const n of niveis) {
    for (const row of loadRows(n)) {
      const nomeNorm = norm(row.nome)
      const idNorm = norm(row.id)
      const matches = cursoTokens.every((t) => nomeNorm.includes(t) || idNorm.includes(t))
      if (!matches) continue
      const g = grauFromCourseName(row.nome) || grauFromCourseName(row.id)
      if (g) graus.add(g)
    }
  }
  return [...graus]
}

function isTecnologoRow(row) {
  if (grauFromCourseName(row.nome) === 'tecnologo' || grauFromCourseName(row.id) === 'tecnologo') return true
  const codigoPrefix = String(row.codigo || '').split('_')[0]
  if (/^TS/i.test(codigoPrefix)) return true
  if (norm(row.codigo).includes('tecnolog') || norm(row.nome).includes('tecnolog')) return true
  return false
}

function pdfDefaultsForRow(row) {
  const isPos = row.nivel === 'pos'
  const duracaoRow = row.duracao != null ? String(row.duracao).trim() : ''
  const duracao = duracaoRow || (isPos ? '6 meses' : isTecnologoRow(row) ? '4 semestres' : '8 semestres')
  return {
    titulacao: isPos ? 'Pós-Graduação (lato sensu)' : 'Graduação',
    duracao,
    investimento: '',
    url: row.url || (isPos ? 'https://mg.sumare.edu.br' : 'https://sumare.edu.br'),
  }
}

export function buildGradePdfInput(row, disciplinas) {
  const defaults = pdfDefaultsForRow(row)
  return {
    cursoNome: row.nome || row.id,
    modalidade: row.modalidade || '',
    titulacao: defaults.titulacao,
    duracao: defaults.duracao,
    investimento: defaults.investimento,
    codigo: row.codigo || '',
    intro: row.intro || '',
    disciplinas,
    url: defaults.url,
  }
}

export function firstName(name) {
  const raw = String(name || '').trim()
  if (!raw || /^lead\s*#/i.test(raw)) return 'Olá'
  return raw.split(/\s+/)[0]
}

export function buildGradePdfIntroText({ nome, cursoNome, modalidade, disciplinasCount, fileName }) {
  return (
    `Oi, ${nome}! Segue em anexo a *grade curricular* de *${cursoNome}* (${modalidade}) em PDF.\n\n` +
    `São *${disciplinasCount} disciplinas/módulos* — abra o arquivo *${fileName}* para ver a lista completa.\n\n` +
    `Posso te ajudar com mais alguma dúvida ou seguir com a inscrição?`
  )
}

/**
 * @param {{ curso: string, modalidade?: string, nivel?: 'grad'|'pos' }} input
 */
export async function resolveGradeForPdf(input) {
  const row = findGradeRow(input)
  if (!row) return { ok: false, code: 'GRADE_NOT_FOUND', error: 'Grade não encontrada nos dados locais.' }
  const disciplinas = (row.pages || []).flatMap((p) => p.disciplinas || []).filter(Boolean)
  if (!disciplinas.length) return { ok: false, code: 'GRADE_EMPTY', error: 'Grade sem disciplinas.' }
  const pdfInput = buildGradePdfInput(row, disciplinas)
  const { buffer, fileName } = await generateGradePdf(pdfInput)
  return { ok: true, row, disciplinas, pdfInput, buffer, fileName }
}
