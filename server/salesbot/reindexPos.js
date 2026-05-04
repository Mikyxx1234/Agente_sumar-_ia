/**
 * Reindex one-shot da tabela `cursos_salesbot_pos_nome`.
 *
 * As linhas (content + metadata) são populadas por SQL direto no
 * Supabase a partir de documents_precos (veja SCHEMA_POS.sql). Aqui
 * só geramos o embedding pra cada `content` e fazemos PATCH na linha.
 *
 * Disparado por POST /api/salesbot/reindex-pos. Idempotente: pode
 * rodar quantas vezes quiser.
 */

import { resolveModel } from '../ai/modelRegistry.js'

/**
 * Normalização aplicada ao texto ANTES de gerar embedding.
 * Lowercase + sem acento. Usada tanto aqui (DB) quanto no probePos
 * e no fluxo principal (query do usuário) — garante que "Libras",
 * "libras", "Saúde Pública" e "saude publica" caiam no mesmo
 * espaço vetorial.
 *
 * IMPORTANTE: se mexer aqui, mexa também em normalizeForEmbedding
 * em csvSearch.js. As duas funções precisam fazer EXATAMENTE a
 * mesma coisa.
 */
export function normalizeForEmbedding(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function ensureConfig(env) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  if (!url || !key) throw new Error('SUPABASE_URL/SUPABASE_KEY não configurados')
  return { apiKey, url: url.replace(/\/$/, ''), key }
}

/**
 * Lê linhas da cursos_salesbot_pos_nome.
 *  - onlyMissing=true (default): só linhas SEM embedding ainda. Ideal
 *    quando você adicionou sinônimos novos via SQL — só processa eles.
 *  - onlyMissing=false: todas as linhas (re-gera todos os embeddings,
 *    mais caro).
 */
async function fetchAllRows({ url, key }, { onlyMissing = true } = {}) {
  const filter = onlyMissing ? 'embedding=is.null&' : ''
  const r = await fetch(
    `${url}/rest/v1/cursos_salesbot_pos_nome?${filter}select=id,content&order=id.asc&limit=5000`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } },
  )
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`GET cursos_salesbot_pos_nome ${r.status}: ${t.slice(0, 200)}`)
  }
  return r.json()
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

async function patchEmbedding({ url, key }, id, vector) {
  const r = await fetch(`${url}/rest/v1/cursos_salesbot_pos_nome?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ embedding: vector }),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`PATCH ${id} ${r.status}: ${t.slice(0, 200)}`)
  }
}

export async function reindexPos(env, opts = {}) {
  const t0 = Date.now()
  const cfg = ensureConfig(env)
  const model = resolveModel(env, 'embeddings')

  // force=true (body ou query) → re-embedda TUDO (caso edite linhas
  // existentes). Default: só processa linhas com embedding NULL —
  // perfeito pra adicionar sinônimos em batch sem custo extra.
  const force = opts.force === true || opts.clear === true

  const rows = await fetchAllRows(cfg, { onlyMissing: !force })
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: true,
      total: 0,
      batches: 0,
      message: force
        ? 'cursos_salesbot_pos_nome vazia. Rode o SQL de SCHEMA_POS.sql primeiro.'
        : 'Nada a processar — todas as linhas já têm embedding. Use { force: true } pra re-embeddar tudo.',
      durationMs: Date.now() - t0,
      model,
    }
  }

  const BATCH = 50
  const PARALLEL_PATCH = 10
  const usage = { prompt_tokens: 0, total_tokens: 0 }
  let batches = 0
  let updated = 0

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const texts = slice.map((r) => normalizeForEmbedding(r.content) || '(sem nome)')
    const { vectors, usage: u } = await embedBatch({ apiKey: cfg.apiKey, model }, texts)
    if (u) {
      usage.prompt_tokens += u.prompt_tokens || u.input_tokens || 0
      usage.total_tokens += u.total_tokens || 0
    }
    for (let j = 0; j < slice.length; j += PARALLEL_PATCH) {
      const chunk = slice.slice(j, j + PARALLEL_PATCH)
      await Promise.all(
        chunk.map((row, kk) => patchEmbedding(cfg, row.id, vectors[j + kk])),
      )
    }
    batches += 1
    updated += slice.length
  }

  return {
    ok: true,
    total: updated,
    batches,
    durationMs: Date.now() - t0,
    usage,
    model,
  }
}
