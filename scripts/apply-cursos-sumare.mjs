/**
 * Aplica a planilha oficial "cursos Sumaré.xlsx" às tabelas RAG.
 * - grad_preco: atualiza modalidade (EAD/Semipresencial) + preço + grau + duração.
 * - grad_info : troca modalidade p/ Semipresencial nos cursos semipresenciais.
 * - pos_preco : atualiza preço (tudo EAD) + marca modalidade EAD.
 * - remove 7 cursos de pós que não estão na planilha (backup antes) em pos_preco e pos_info.
 * Re-embedda tudo que muda (text-embedding-3-small / 1536 dims).
 *
 * Mapa por ID (verificado nos dumps reais). Não renomeia cursos (exceto fix id=168).
 *
 * Uso:
 *   node --env-file=.env scripts/apply-cursos-sumare.mjs --dry-run
 *   node --env-file=.env scripts/apply-cursos-sumare.mjs
 */
import fs from 'node:fs'
import { resolveModel } from '../server/ai/modelRegistry.js'

const DRY = process.argv.includes('--dry-run')
const env = process.env
const U = (env.SUPABASE_URL || '').replace(/\/$/, '')
const K = env.SUPABASE_KEY || ''
const H = { apikey: K, Authorization: `Bearer ${K}` }

// grad_preco: id -> { mod, d(desconto), c(cheio), grau, dur }  (curso preservado da linha)
const GRAD = {
  128: { mod: 'EAD', d: 107, c: 357, grau: 'Bacharelado', dur: '8 Semestres' },
  129: { mod: 'EAD', d: 97, c: 323, grau: 'Tecnólogo', dur: '5 Semestres' },
  130: { mod: 'Semipresencial', d: 257, c: 860, grau: 'Bacharelado', dur: '10 Semestres' },
  131: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '5 Semestres' },
  132: { mod: 'Semipresencial', d: 237, c: 790, grau: 'Bacharelado', dur: '8 Semestres' },
  133: { mod: 'EAD', d: 97, c: 323, grau: 'Bacharelado', dur: '8 Semestres' },
  134: { mod: 'EAD', d: 107, c: 323, grau: 'Bacharelado', dur: '8 Semestres' },
  135: { mod: 'EAD', d: 97, c: 323, grau: 'Bacharelado', dur: '8 Semestres' },
  136: { mod: 'Semipresencial', d: 177, c: 590, grau: 'Bacharelado', dur: '8 Semestres' },
  137: { mod: 'Semipresencial', d: 149, c: 590, grau: 'Licenciatura', dur: '8 Semestres' },
  138: { mod: 'Semipresencial', d: 237, c: 790, grau: 'Bacharelado', dur: '10 Semestres' },
  139: { mod: 'Semipresencial', d: 237, c: 790, grau: 'Bacharelado', dur: '10 Semestres' },
  140: { mod: 'Semipresencial', d: 237, c: 790, grau: 'Bacharelado', dur: '10 Semestres' },
  141: { mod: 'Semipresencial', d: 237, c: 790, grau: 'Bacharelado', dur: '10 Semestres' },
  142: { mod: 'Semipresencial', d: 227, c: 757, grau: 'Bacharelado', dur: '10 Semestres' },
  143: { mod: 'Semipresencial', d: 227, c: 790, grau: 'Bacharelado', dur: '10 Semestres' },
  144: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '4 Semestres' },
  145: { mod: 'Semipresencial', d: 107, c: 357, grau: 'Licenciatura', dur: '8 Semestres' },
  146: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '4 Semestres' },
  147: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '4 Semestres' },
  148: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '5 Semestres' },
  149: { mod: 'EAD', d: 97, c: 323, grau: 'Tecnólogo', dur: '4 Semestres' },
  150: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '4 Semestres' },
  151: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '4 Semestres' },
  152: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '4 Semestres' },
  153: { mod: 'Semipresencial', d: 107, c: 357, grau: 'Licenciatura', dur: '8 Semestres' },
  154: { mod: 'EAD', d: 57, c: 290, grau: 'Tecnólogo', dur: '5 Semestres' },
  155: { mod: 'EAD', d: 87, c: 290, grau: 'Bacharelado', dur: '8 Semestres' },
  156: { mod: 'Semipresencial', d: 107, c: 357, grau: 'Licenciatura', dur: '8 Semestres' },
  157: { mod: 'EAD', d: 97, c: 323, grau: 'Tecnólogo', dur: '4 Semestres' },
  158: { mod: 'EAD', d: 97, c: 323, grau: 'Tecnólogo', dur: '4 Semestres' },
  159: { mod: 'Semipresencial', d: 107, c: 357, grau: 'Licenciatura', dur: '8 Semestres' },
  160: { mod: 'Semipresencial', d: 237, c: 790, grau: 'Bacharelado', dur: '8 Semestres' },
  161: { mod: 'Semipresencial', d: 117, c: 390, grau: 'Licenciatura', dur: '8 Semestres' },
  162: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '4 Semestres' },
  163: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '5 Semestres' },
  164: { mod: 'EAD', d: 87, c: 290, grau: 'Bacharelado', dur: '7 Semestres' },
  165: { mod: 'EAD', d: 87, c: 290, grau: 'Tecnólogo', dur: '5 Semestres' },
  166: { mod: 'Semipresencial', d: 147, c: 490, grau: 'Tecnólogo', dur: '4 Semestres' },
  167: { mod: 'Semipresencial', d: 167, c: 557, grau: 'Bacharelado', dur: '8 Semestres' },
  168: { mod: 'EAD', d: 97, c: 323, grau: 'Bacharelado', dur: '8 Semestres', cursoFix: 'Sistemas de Informação' },
}

// pos_preco: id -> { d, c } (tudo EAD). Ausentes = remover.
const POS = {
  124: { d: 187, c: 623 }, 125: { d: 187, c: 623 }, 126: { d: 187, c: 623 }, 127: { d: 187, c: 623 },
  129: { d: 227, c: 757 }, 130: { d: 187, c: 623 }, 131: { d: 187, c: 623 }, 133: { d: 187, c: 623 },
  134: { d: 187, c: 623 }, 136: { d: 187, c: 623 }, 137: { d: 187, c: 623 }, 138: { d: 187, c: 623 },
  139: { d: 399, c: 998 }, 140: { d: 187, c: 623 }, 142: { d: 187, c: 623 }, 143: { d: 191, c: 637 },
  144: { d: 191, c: 637 }, 145: { d: 191, c: 637 }, 146: { d: 191, c: 637 }, 147: { d: 191, c: 637 },
  148: { d: 191, c: 637 }, 149: { d: 191, c: 637 }, 150: { d: 191, c: 637 }, 151: { d: 191, c: 637 },
  152: { d: 191, c: 637 }, 153: { d: 191, c: 637 }, 154: { d: 191, c: 637 }, 155: { d: 191, c: 637 },
  156: { d: 191, c: 637 }, 157: { d: 191, c: 637 }, 158: { d: 191, c: 637 }, 160: { d: 191, c: 637 },
  161: { d: 191, c: 637 }, 163: { d: 191, c: 637 },
}
const POS_DELETE_PRECO_IDS = [128, 132, 135, 141, 159, 162, 164]
// pos_info correspondentes (ids explícitos; alguns têm curso corrompido por CSV deslocado)
const POS_DELETE_INFO_IDS = [87, 91, 94, 100, 118, 121, 123]

function getField(content, label) {
  const m = String(content || '').match(new RegExp(`${label}:\\s*([^|]+)`, 'i'))
  return m ? m[1].trim() : ''
}
function normName(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

async function getRows(table) {
  const r = await fetch(`${U}/rest/v1/${table}?select=id,content,metadata&order=id.asc&limit=500`, { headers: H })
  if (!r.ok) throw new Error(`${table} ${r.status}`)
  return await r.json()
}
async function embedBatch(texts) {
  const model = resolveModel(env, 'embeddings')
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY}` },
    body: JSON.stringify({ model, input: texts }),
  })
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return (await r.json()).data.map((d) => d.embedding)
}
async function patch(table, id, body) {
  const r = await fetch(`${U}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`PATCH ${table} ${id} ${r.status}: ${(await r.text()).slice(0, 200)}`)
}
async function del(table, id) {
  const r = await fetch(`${U}/rest/v1/${table}?id=eq.${id}`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } })
  if (!r.ok) throw new Error(`DELETE ${table} ${id} ${r.status}: ${(await r.text()).slice(0, 200)}`)
}

async function main() {
  if (!U || !K) throw new Error('SUPABASE_URL/KEY ausentes')
  const [gradPreco, gradInfo, posPreco, posInfo] = await Promise.all([
    getRows('grad_preco'), getRows('grad_info'), getRows('pos_preco'), getRows('pos_info'),
  ])
  /** @type {{table:string,id:number,content:string,metadata:object}[]} */
  const updates = []

  // grad_preco
  for (const row of gradPreco) {
    const m = GRAD[row.id]
    if (!m) { console.warn(`! grad_preco id=${row.id} sem mapa`); continue }
    const cursoBare = m.cursoFix || getField(row.content, 'nome_curso').replace(/^Graduação\s*-\s*/i, '').trim()
    const content =
      `chave: ${cursoBare} | nome_curso: Graduação - ${cursoBare} | modalidade: ${m.mod} | grau: ${m.grau} | duracao: ${m.dur} | preco cheio: ${m.c} | preco com desconto: ${m.d} | grad ou pos: GRADUACAO`
    const metadata = { ...(row.metadata || {}), modalidade: m.mod, grau: m.grau, duracao: m.dur, price_source: 'planilha_cursos_sumare_2026', price_sync_at: new Date().toISOString() }
    updates.push({ table: 'grad_preco', id: row.id, content, metadata, old: row.content })
  }

  // pos_preco (updates) + deletions
  for (const row of posPreco) {
    if (POS_DELETE_PRECO_IDS.includes(row.id)) continue
    const m = POS[row.id]
    if (!m) { console.warn(`! pos_preco id=${row.id} sem mapa`); continue }
    const curso = getField(row.content, 'curso')
    const content =
      `chave: ${curso} | curso: ${curso} | modalidade: EAD | preco cheio: ${m.c} | preco com desconto: ${m.d} | grad ou pos: ${m.d} | col6: POS`
    const metadata = { ...(row.metadata || {}), modalidade: 'EAD', price_source: 'planilha_cursos_sumare_2026', price_sync_at: new Date().toISOString() }
    updates.push({ table: 'pos_preco', id: row.id, content, metadata, old: row.content })
  }

  // grad_info: troca modalidade -> Semipresencial nos cursos semipresenciais (via nome do curso)
  // Conjunto de nomes semipresenciais a partir do que aplicamos em grad_preco
  const semiCursoNorm = new Set()
  for (const u of updates.filter((x) => x.table === 'grad_preco')) {
    if (/modalidade:\s*Semipresencial/i.test(u.content)) semiCursoNorm.add(normName(getField(u.content, 'nome_curso').replace(/^Graduação\s*-\s*/i, '')))
  }
  for (const row of gradInfo) {
    const curso = getField(row.content, 'nome_curso').replace(/^Graduação\s*-\s*/i, '').trim()
    if (!semiCursoNorm.has(normName(curso))) continue
    if (/modalidade:\s*Semipresencial/i.test(row.content)) continue
    const content = row.content.replace(/modalidade:\s*[^|]+/i, 'modalidade: Semipresencial ')
      .replace(/\s+\|/g, ' |').replace(/\s{2,}/g, ' ')
    const metadata = { ...(row.metadata || {}), modalidade: 'Semipresencial' }
    updates.push({ table: 'grad_info', id: row.id, content, metadata, old: row.content })
  }

  // Deleções de pós (ids explícitos em preco e info)
  const delPlan = []
  for (const id of POS_DELETE_PRECO_IDS) {
    const row = posPreco.find((r) => r.id === id)
    if (!row) { console.warn(`! pos_preco delete id=${id} não encontrado`); continue }
    delPlan.push({ table: 'pos_preco', id, curso: getField(row.content, 'curso'), content: row.content, metadata: row.metadata })
  }
  for (const id of POS_DELETE_INFO_IDS) {
    const row = posInfo.find((r) => r.id === id)
    if (!row) { console.warn(`! pos_info delete id=${id} não encontrado`); continue }
    delPlan.push({ table: 'pos_info', id, curso: getField(row.content, 'curso') || getField(row.content, 'chave'), content: row.content, metadata: row.metadata })
  }

  // Relatório
  console.log(DRY ? '== DRY-RUN ==' : '== APLICANDO ==')
  console.log(`\nUpdates: grad_preco=${updates.filter(u=>u.table==='grad_preco').length} pos_preco=${updates.filter(u=>u.table==='pos_preco').length} grad_info(semi)=${updates.filter(u=>u.table==='grad_info').length}`)
  for (const u of updates.filter(u=>u.table==='grad_preco' && /Semipresencial/.test(u.content)).slice(0,3)) {
    console.log(`  [ex grad] id=${u.id}\n    OLD: ${u.old}\n    NEW: ${u.content}`)
  }
  console.log(`\nDeleções (${delPlan.length} linhas):`)
  for (const d of delPlan) console.log(`  DEL ${d.table} id=${d.id} :: ${d.curso}`)

  if (DRY) { console.log('\n[dry-run] nada gravado.'); return }

  // Backup das deleções
  const backupPath = `scripts/backup-pos-removidos-${Date.now()}.json`
  fs.writeFileSync(backupPath, JSON.stringify(delPlan, null, 2))
  console.log(`\nBackup salvo em ${backupPath}`)

  // Embeddings em lote
  const BATCH = 40
  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH)
    const vecs = await embedBatch(slice.map((s) => s.content))
    for (let j = 0; j < slice.length; j++) {
      await patch(slice[j].table, slice[j].id, { content: slice[j].content, embedding: vecs[j], metadata: slice[j].metadata })
    }
    console.log(`  atualizados ${Math.min(i + BATCH, updates.length)}/${updates.length}`)
  }

  // Deleções
  for (const d of delPlan) { await del(d.table, d.id); console.log(`  removido ${d.table} id=${d.id}`) }

  console.log('\nConcluído.')
}

main().catch((e) => { console.error(e); process.exit(1) })
