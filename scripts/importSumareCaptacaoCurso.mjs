/**
 * Importa códigos de curso da planilha Excel para sumare_captacao_curso (Supabase).
 *
 * Uso:
 *   node --env-file=.env scripts/ensureSumareCaptacaoCursoTable.mjs
 *   node --env-file=.env scripts/importSumareCaptacaoCurso.mjs [caminho.xlsx]
 *
 * Colunas esperadas: codigo_original, codigo_base, curso_decifrado, modalidade
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const defaultXlsx = path.join(root, 'data', 'sumare-captacao-curso.xlsx')

function loadEnv() {
  const env = { ...process.env }
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return env
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!k || env[k]) continue
    env[k] = line.slice(i + 1)
  }
  return env
}

function normalizeModalidade(raw) {
  const s = String(raw || '').trim()
  if (!s) return 'Não informado'
  if (/^ead$/i.test(s)) return 'EAD'
  if (/semi/i.test(s)) return 'Semipresencial'
  if (/n[aã]o informado/i.test(s)) return 'Não informado'
  return s
}

async function readRowsFromXlsx(filePath) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('Planilha vazia')

  const headerRow = ws.getRow(1)
  const headers = {}
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    headers[String(cell.value || '').trim().toLowerCase()] = col
  })

  const colOriginal = headers.codigo_original
  const colBase = headers.codigo_base
  const colCurso = headers.curso_decifrado
  const colModal = headers.modalidade
  if (!colOriginal || !colBase || !colCurso) {
    throw new Error(`Cabeçalhos inválidos. Esperado codigo_original, codigo_base, curso_decifrado. Got: ${JSON.stringify(headers)}`)
  }

  const rows = []
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const codigoOriginal = String(row.getCell(colOriginal).value ?? '').trim().toUpperCase()
    const codigoBase = String(row.getCell(colBase).value ?? '').trim().toUpperCase()
    const cursoNome = String(row.getCell(colCurso).value ?? '').trim()
    const modalidade = normalizeModalidade(colModal ? row.getCell(colModal).value : '')
    if (!codigoOriginal || !cursoNome) continue
    rows.push({ codigo_original: codigoOriginal, codigo_base: codigoBase, curso_nome: cursoNome, modalidade })
  }
  return rows
}

async function upsertBatch(env, table, batch) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || ''
  const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?on_conflict=codigo_original`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(
      batch.map((r) => ({
        ...r,
        ativo: true,
        updated_at: new Date().toISOString(),
      })),
    ),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Upsert HTTP ${res.status}: ${text.slice(0, 400)}`)
  }
}

async function main() {
  const env = loadEnv()
  const table = env.SUMARE_CAPTACAO_CURSO_TABLE || 'sumare_captacao_curso'
  const xlsxPath = path.resolve(process.argv[2] || defaultXlsx)

  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    console.error('SUPABASE_URL e SUPABASE_KEY são obrigatórios.')
    process.exit(1)
  }
  if (!fs.existsSync(xlsxPath)) {
    console.error(`Arquivo não encontrado: ${xlsxPath}`)
    process.exit(1)
  }

  const rows = await readRowsFromXlsx(xlsxPath)
  console.log(`Lidos ${rows.length} cursos de ${xlsxPath}`)

  const chunkSize = 50
  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = rows.slice(i, i + chunkSize)
    await upsertBatch(env, table, batch)
    console.log(`Upsert ${i + batch.length}/${rows.length}`)
  }

  const countRes = await fetch(
    `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(table)}?select=codigo_original&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${env.SUPABASE_KEY}`,
        Prefer: 'count=exact',
      },
    },
  )
  console.log('Import concluído. Total na tabela (header):', countRes.headers.get('content-range') || countRes.status)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
