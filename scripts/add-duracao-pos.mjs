/**
 * Grava a duração dos cursos de PÓS-GRADUAÇÃO em `pos_preco`.
 * Conforme a planilha oficial, TODA pós tem duração de 6 meses.
 *
 * - Insere "duracao: 6 Meses" no `content` (após "modalidade: …") quando ausente.
 * - Grava `metadata.duracao = '6 Meses'`.
 * - Reembeda o content alterado (mesmo modelo do RAG: text-embedding-3-small / 1536).
 *
 * Idempotente: pula linhas que já têm "duracao:" no content.
 * Uso:
 *   node --env-file=.env scripts/add-duracao-pos.mjs --dry-run
 *   node --env-file=.env scripts/add-duracao-pos.mjs
 */

import { resolveModel } from '../server/ai/modelRegistry.js'

const DRY_RUN = process.argv.includes('--dry-run')
const env = { ...process.env }
const URL = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const KEY = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
const DURACAO = '6 Meses'
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function embed(text) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY ausente')
  const model = resolveModel(env, 'embeddings')
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: text }),
  })
  if (!r.ok) throw new Error(`OpenAI embeddings ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  return data.data[0].embedding
}

function insertDuracao(content) {
  if (/(^|\|)\s*duracao\s*:/i.test(content)) return content
  if (/modalidade\s*:\s*[^|]+\|/i.test(content)) {
    return content.replace(/(modalidade\s*:\s*[^|]+\|)/i, `$1 duracao: ${DURACAO} |`)
  }
  return `${content.trim()} | duracao: ${DURACAO}`
}

async function main() {
  if (!URL || !KEY) throw new Error('SUPABASE_URL/KEY ausentes')
  const res = await fetch(`${URL}/rest/v1/pos_preco?select=id,content,metadata&order=id.asc&limit=200`, { headers: H })
  const rows = await res.json()
  if (!Array.isArray(rows)) throw new Error('falha ao ler pos_preco')

  let changed = 0
  let skipped = 0
  for (const row of rows) {
    const content = String(row.content || '')
    if (/(^|\|)\s*duracao\s*:/i.test(content)) {
      skipped += 1
      continue
    }
    const newContent = insertDuracao(content)
    const newMeta = { ...(row.metadata || {}), duracao: DURACAO }
    console.log(`id=${row.id}: ${newContent}`)
    if (DRY_RUN) {
      changed += 1
      continue
    }
    const embedding = await embed(newContent)
    const upd = await fetch(`${URL}/rest/v1/pos_preco?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ content: newContent, metadata: newMeta, embedding }),
    })
    if (!upd.ok) {
      console.log(`  ERRO id=${row.id} status=${upd.status} ${(await upd.text()).slice(0, 200)}`)
      continue
    }
    changed += 1
  }
  console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}pos_preco: ${changed} atualizadas, ${skipped} já tinham duração.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
