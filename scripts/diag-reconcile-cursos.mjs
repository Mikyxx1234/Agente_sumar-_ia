/**
 * Reconcilia a planilha "cursos Sumaré.xlsx" com as 4 tabelas RAG
 * (grad_preco, grad_info, pos_preco, pos_info). Apenas leitura/diagnóstico.
 *
 * Uso: node --env-file=.env scripts/diag-reconcile-cursos.mjs "C:/caminho/cursos Sumaré.xlsx"
 */
import ExcelJS from 'exceljs'
import { normName } from '../libShared/precosSumareCatalog.js'

const XLSX = process.argv[2] || 'C:/Users/user/Downloads/cursos Sumaré.xlsx'
const env = process.env
const U = (env.SUPABASE_URL || '').replace(/\/$/, '')
const K = env.SUPABASE_KEY || ''

function cellText(c) {
  let v = c?.value
  if (v && typeof v === 'object') {
    if (v.text) v = v.text
    else if (v.result !== undefined) v = v.result
    else v = ''
  }
  return v == null ? '' : String(v).trim()
}

async function readSheet() {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(XLSX)
  const out = { grad: [], pos: [] }
  for (const ws of wb.worksheets) {
    const isPos = /p[óo]s/i.test(ws.name)
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const curso = cellText(row.getCell(1))
      if (!curso) continue
      const bruto = cellText(row.getCell(2))
      const mensal = cellText(row.getCell(3))
      const modalidade = cellText(row.getCell(4))
      const c5 = cellText(row.getCell(5))
      const c6 = cellText(row.getCell(6))
      const rec = isPos
        ? { curso, bruto, mensal, modalidade, duracao: c5 }
        : { curso, bruto, mensal, modalidade, grau: c5, duracao: c6 }
      ;(isPos ? out.pos : out.grad).push(rec)
    }
  }
  return out
}

function extractCursoFromContent(content) {
  const s = String(content || '')
  const get = (label) => {
    const m = s.match(new RegExp(`${label}:\\s*([^|]+)`, 'i'))
    return m ? m[1].trim() : ''
  }
  return get('curso') || get('nome_curso') || get('chave')
}

async function fetchTable(table) {
  const r = await fetch(`${U}/rest/v1/${table}?select=id,content,metadata&order=id.asc&limit=500`, {
    headers: { apikey: K, Authorization: `Bearer ${K}` },
  })
  const rows = await r.json()
  return rows.map((row) => ({ id: row.id, curso: extractCursoFromContent(row.content), content: row.content }))
}

function matchRow(sheetCurso, tableRows) {
  const n = normName(sheetCurso)
  for (const tr of tableRows) {
    const c = normName(tr.curso)
    if (n && c && (n === c || n.includes(c) || c.includes(n))) return tr
  }
  return null
}

async function reconcile(label, sheetRows, precoRows, infoRows) {
  console.log(`\n========== ${label} ==========`)
  console.log(`planilha=${sheetRows.length} | ${label}_preco=${precoRows.length} | ${label}_info=${infoRows.length}`)
  const matchedPrecoIds = new Set()
  console.log('\n-- cursos da planilha → linha em *_preco --')
  for (const s of sheetRows) {
    const m = matchRow(s.curso, precoRows)
    if (m) matchedPrecoIds.add(m.id)
    console.log(`  [${m ? 'UPDATE id=' + m.id : 'INSERT (novo)'}] ${s.modalidade.padEnd(15)} ${s.curso}  (${s.mensal}/${s.bruto})`)
  }
  const extras = precoRows.filter((r) => !matchedPrecoIds.has(r.id))
  console.log(`\n-- em ${label}_preco mas NÃO na planilha (${extras.length}) --`)
  for (const e of extras) console.log(`  id=${e.id}  ${e.curso}`)
}

async function main() {
  const sheet = await readSheet()
  const [gradPreco, gradInfo, posPreco, posInfo] = await Promise.all([
    fetchTable('grad_preco'), fetchTable('grad_info'), fetchTable('pos_preco'), fetchTable('pos_info'),
  ])
  await reconcile('grad', sheet.grad, gradPreco, gradInfo)
  await reconcile('pos', sheet.pos, posPreco, posInfo)
}

main().catch((e) => { console.error(e); process.exit(1) })
