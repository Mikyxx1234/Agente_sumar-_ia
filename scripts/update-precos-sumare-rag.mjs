/**
 * Atualiza pos_preco e grad_preco no Supabase com preços do site oficial
 * e re-vetoriza (embedding OpenAI text-embedding-3-small).
 *
 * Uso:
 *   node --env-file=.env scripts/update-precos-sumare-rag.mjs
 *   node --env-file=.env scripts/update-precos-sumare-rag.mjs --dry-run
 */

import { resolveModel } from '../server/ai/modelRegistry.js'
import {
  parsePipeContent,
  buildPosPrecoContent,
  buildGradPrecoContent,
  resolvePosPrices,
  resolveGradPrices,
  priceInt,
} from '../libShared/precosSumareCatalog.js'

const EMBED_BATCH = 40
const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')

// DEPRECADO (2026-06): a fonte de verdade de preço/modalidade passou a ser a
// planilha oficial aplicada por scripts/apply-cursos-sumare.mjs. Este script
// usa o catálogo legado (sem modalidade) e REVERTERIA a coluna modalidade
// das tabelas. Só roda com --force.
if (!FORCE) {
  console.error(
    'DEPRECADO: use scripts/apply-cursos-sumare.mjs (planilha oficial é a fonte de verdade).\n' +
      'Este script legado reverteria a modalidade (EAD/Semipresencial). Se realmente precisar, rode com --force.',
  )
  process.exit(1)
}

function loadEnv() {
  const env = { ...process.env }
  return env
}

async function fetchAllRows(env, table) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || ''
  const r = await fetch(`${url}/rest/v1/${table}?select=id,content,metadata&order=id.asc&limit=500`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  if (!r.ok) throw new Error(`${table} GET ${r.status}: ${await r.text()}`)
  return await r.json()
}

async function embedBatch(env, texts) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  const model = resolveModel(env, 'embeddings')
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  })
  if (!r.ok) throw new Error(`OpenAI embeddings ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  return (data.data || []).map((d) => d.embedding)
}

async function patchRow(env, table, id, { content, embedding, metadata }) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || ''
  const r = await fetch(`${url}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ content, embedding, metadata }),
  })
  if (!r.ok) throw new Error(`PATCH ${table} id=${id} ${r.status}: ${(await r.text()).slice(0, 300)}`)
}

function mergeMetadata(prev, patch) {
  const base = prev && typeof prev === 'object' ? { ...prev } : {}
  return { ...base, ...patch, price_sync_at: new Date().toISOString(), source: prev?.source || 'PRODUTO_SUMAR_MODELO' }
}

async function processTable(env, table, tipo) {
  const rows = await fetchAllRows(env, table)
  const planned = []

  for (const row of rows) {
    const parsed = parsePipeContent(row.content)
    let newContent
    let priceSource

    if (tipo === 'pos') {
      const p = resolvePosPrices(row.id, parsed)
      newContent = buildPosPrecoContent({
        chave: p.chave || parsed.chave,
        curso: p.curso || parsed.curso,
        precoCheio: p.cheio,
        precoDesconto: p.desc,
      })
      priceSource = p.source
    } else {
      const p = resolveGradPrices(parsed)
      newContent = buildGradPrecoContent({
        chave: p.chave || parsed.chave,
        nomeCurso: p.nomeCurso || parsed.curso,
        precoCheio: p.cheio,
        precoDesconto: p.desc,
      })
      priceSource = p.source
    }

    const changed = newContent !== row.content
    planned.push({
      id: row.id,
      oldContent: row.content,
      newContent,
      changed,
      priceSource,
      metadata: mergeMetadata(row.metadata, { price_source: priceSource, kind: row.metadata?.kind || 'csv_row' }),
    })
  }

  const toUpdate = planned.filter((p) => p.changed)
  console.log(`\n── ${table}: ${rows.length} linhas, ${toUpdate.length} a atualizar`)

  let updated = 0
  for (let i = 0; i < toUpdate.length; i += EMBED_BATCH) {
    const slice = toUpdate.slice(i, i + EMBED_BATCH)
    const vectors = DRY_RUN ? slice.map(() => null) : await embedBatch(env, slice.map((s) => s.newContent))

    for (let j = 0; j < slice.length; j++) {
      const item = slice[j]
      if (DRY_RUN) {
        console.log(`  [dry-run] id=${item.id} ${item.priceSource}`)
        console.log(`    antes: ${item.oldContent.slice(0, 120)}...`)
        console.log(`    depois: ${item.newContent.slice(0, 120)}...`)
        continue
      }
      await patchRow(env, table, item.id, {
        content: item.newContent,
        embedding: vectors[j],
        metadata: item.metadata,
      })
      updated += 1
      if (updated % 10 === 0 || updated === toUpdate.length) {
        console.log(`  atualizados ${updated}/${toUpdate.length}`)
      }
    }
  }

  const sample = toUpdate.find((p) => /Psicopedagogia com Ênfase/i.test(p.newContent))
  if (sample) {
    console.log(`  amostra Psicopedagogia id=${sample.id}: ${sample.newContent}`)
  }

  return { total: rows.length, updated: toUpdate.length, skipped: rows.length - toUpdate.length }
}

async function verifySample(env) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || ''
  const q = 'pos_preco?select=id,content&id=eq.124'
  const r = await fetch(`${url}/rest/v1/${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  const data = await r.json()
  console.log('\n── Verificação pós-update (id 124):', data[0]?.content)
}

async function main() {
  const env = loadEnv()
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw new Error('SUPABASE_URL/KEY ausentes')
  if (!env.OPENAI_API_KEY && !DRY_RUN) throw new Error('OPENAI_API_KEY ausente')

  console.log(DRY_RUN ? 'MODO DRY-RUN (sem PATCH)' : 'Atualizando Supabase + embeddings...')

  const posStats = await processTable(env, 'pos_preco', 'pos')
  const gradStats = await processTable(env, 'grad_preco', 'grad')

  if (!DRY_RUN) await verifySample(env)

  console.log('\nResumo:', JSON.stringify({ posStats, gradStats, dryRun: DRY_RUN }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
