/**
 * Reindex one-shot da tabela `cursos_salesbot_pos_nome`.
 *
 * Lê todos os cursos da `cursos_salesbot_pos`, gera embedding pra cada
 * nome (via OpenAI text-embedding-3-small), e faz upsert na tabela
 * vetorial. Idempotente: pode ser rodado múltiplas vezes.
 *
 * Disparado por POST /api/salesbot/reindex-pos.
 */

import { resolveModel } from '../ai/modelRegistry.js'

function ensureConfig(env) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  if (!url || !key) throw new Error('SUPABASE_URL/SUPABASE_KEY não configurados')
  return { apiKey, url: url.replace(/\/$/, ''), key }
}

async function fetchAllCursos({ url, key }) {
  const r = await fetch(`${url}/rest/v1/cursos_salesbot_pos?select=id,Curso&order=id.asc&limit=2000`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`GET cursos_salesbot_pos ${r.status}: ${t.slice(0, 200)}`)
  }
  return r.json()
}

async function clearVectorTable({ url, key }) {
  const r = await fetch(`${url}/rest/v1/cursos_salesbot_pos_nome?id=gte.0`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`DELETE vetor ${r.status}: ${t.slice(0, 200)}`)
  }
}

async function embedBatch({ apiKey, model }, texts) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`OpenAI embeddings ${r.status}: ${t.slice(0, 200)}`)
  }
  const data = await r.json()
  return {
    vectors: (data.data || []).map((d) => d.embedding),
    usage: data.usage || null,
  }
}

async function insertVectorRows({ url, key }, rows) {
  const r = await fetch(`${url}/rest/v1/cursos_salesbot_pos_nome`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`POST vetor ${r.status}: ${t.slice(0, 300)}`)
  }
}

export async function reindexPos(env, opts = {}) {
  const t0 = Date.now()
  const cfg = ensureConfig(env)
  const model = resolveModel(env, 'embeddings')
  const clear = opts.clear !== false

  const cursos = await fetchAllCursos(cfg)
  if (!Array.isArray(cursos) || cursos.length === 0) {
    return {
      ok: false,
      total: 0,
      batches: 0,
      error: 'Tabela cursos_salesbot_pos vazia — rode "Reconstruir catálogo pós" antes.',
      durationMs: Date.now() - t0,
      model,
    }
  }

  if (clear) await clearVectorTable(cfg)

  const BATCH = 50
  const usage = { prompt_tokens: 0, total_tokens: 0 }
  let batches = 0
  let inserted = 0

  for (let i = 0; i < cursos.length; i += BATCH) {
    const slice = cursos.slice(i, i + BATCH)
    const texts = slice.map((c) => String(c.Curso || '').trim())
    const { vectors, usage: u } = await embedBatch({ apiKey: cfg.apiKey, model }, texts)
    if (u) {
      usage.prompt_tokens += u.prompt_tokens || u.input_tokens || 0
      usage.total_tokens += u.total_tokens || 0
    }
    const rows = slice.map((c, idx) => ({
      curso_id: c.id,
      content: c.Curso || '',
      metadata: { tipo: 'pos-graduacao', curso_id: c.id, curso: c.Curso || '' },
      embedding: vectors[idx],
    }))
    await insertVectorRows(cfg, rows)
    batches += 1
    inserted += rows.length
  }

  return { ok: true, total: inserted, batches, durationMs: Date.now() - t0, usage, model }
}
