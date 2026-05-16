/**
 * Reenvia os 4 CSVs da Sumaré para as tabelas RAG (com normalização EAD).
 * Uso: node --env-file=.env scripts/reupload_rag_sumare.mjs
 */
import { readFile } from 'node:fs/promises'
import { uploadKnowledge, clearKnowledgeTable } from '../server/ai/knowledgeUpload.js'

const FILES = [
  { table: 'grad_preco', path: String.raw`C:\Users\Caio\Downloads\PRODUTO_GRADUACAO_SUMARE_MODELO.csv` },
  { table: 'pos_preco', path: String.raw`C:\Users\Caio\Downloads\PRODUTO_POS_SUMARE_MODELO.csv` },
  { table: 'grad_info', path: String.raw`C:\Users\Caio\Desktop\sumare info grad.csv` },
  { table: 'pos_info', path: String.raw`C:\Users\Caio\Desktop\sumare info pos.csv` },
]

for (const { table, path } of FILES) {
  console.log(`\n── ${table} ← ${path}`)
  const buffer = await readFile(path)
  await clearKnowledgeTable(process.env, table)
  const out = await uploadKnowledge(process.env, {
    table,
    buffer,
    filename: path.split(/[/\\]/).pop(),
    mimeType: 'text/csv',
  })
  console.log(`   inseridos: ${out.inserted} chunks em ${out.durationMs}ms`)
}

console.log('\nConcluído.')
