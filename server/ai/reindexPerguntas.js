/**
 * Reindex das linhas de `documents_perguntas` (FAQ).
 *
 * Disparado por POST /api/ai/reindex-perguntas. Espelha o que o
 * salesbot já faz com cursos_salesbot_pos_nome:
 *   - Default: gera embedding só pras linhas com `embedding IS NULL`
 *     (perfeito depois de inserir uma nova pergunta via SQL).
 *   - Com `{ force: true }`: regenera embedding de TODAS as linhas
 *     (use quando mudar a normalização do texto, por exemplo).
 *
 * Usa a mesma normalização (lowercase + sem acento) do reindexPos —
 * importada de lá pra garantir paridade com a query feita pelo
 * orquestrador no buscar_perguntas (que também precisa normalizar).
 */

import { resolveModel } from './modelRegistry.js'
import { normalizeForEmbedding } from '../salesbot/reindexPos.js'

function ensureConfig(env) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  if (!url || !key) throw new Error('SUPABASE_URL/SUPABASE_KEY não configurados')
  return { apiKey, url: url.replace(/\/$/, ''), key }
}

async function fetchAllRows({ url, key }, { onlyMissing = true } = {}) {
  // Quando onlyMissing=true, pegamos:
  //   (a) linhas com embedding NULL                       — caso documents_perguntas algum dia permita NULL;
  //   (b) linhas com metadata.embedding_pendente = true   — usado pelos INSERTs SQL que precisam de placeholder
  //       (a coluna embedding é NOT NULL hoje, então o SQL grava com vetor zero
  //       e marca a flag; o reindex regenera o vetor de verdade e remove a flag).
  const filter = onlyMissing
    ? 'or=(embedding.is.null,metadata->>embedding_pendente.eq.true)&'
    : ''
  const r = await fetch(
    `${url}/rest/v1/documents_perguntas?${filter}select=id,content,metadata&order=id.asc&limit=5000`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } },
  )
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`GET documents_perguntas ${r.status}: ${t.slice(0, 200)}`)
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

async function patchEmbedding({ url, key }, id, vector, currentMetadata) {
  // Se a linha tinha a flag `embedding_pendente`, removemos junto com o
  // PATCH do embedding — assim o reindex não fica reprocessando ela
  // toda vez. PostgREST não tem JSONB-delete-key direto, então mandamos
  // o objeto inteiro sem a chave (PATCH substitui o campo metadata
  // como um todo, é o comportamento do PostgREST).
  const body = { embedding: vector }
  if (currentMetadata && typeof currentMetadata === 'object' && 'embedding_pendente' in currentMetadata) {
    const cleaned = { ...currentMetadata }
    delete cleaned.embedding_pendente
    body.metadata = cleaned
  }
  const r = await fetch(`${url}/rest/v1/documents_perguntas?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`PATCH ${id} ${r.status}: ${t.slice(0, 200)}`)
  }
}

export async function reindexPerguntas(env, opts = {}) {
  const t0 = Date.now()
  const cfg = ensureConfig(env)
  const model = resolveModel(env, 'embeddings')
  const force = opts.force === true || opts.clear === true

  const rows = await fetchAllRows(cfg, { onlyMissing: !force })
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: true,
      total: 0,
      batches: 0,
      message: force
        ? 'documents_perguntas vazia.'
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
    const texts = slice.map((r) => normalizeForEmbedding(r.content) || '(sem conteudo)')
    const { vectors, usage: u } = await embedBatch({ apiKey: cfg.apiKey, model }, texts)
    if (u) {
      usage.prompt_tokens += u.prompt_tokens || u.input_tokens || 0
      usage.total_tokens += u.total_tokens || 0
    }
    for (let j = 0; j < slice.length; j += PARALLEL_PATCH) {
      const chunk = slice.slice(j, j + PARALLEL_PATCH)
      await Promise.all(
        chunk.map((row, kk) =>
          patchEmbedding(cfg, row.id, vectors[j + kk], row.metadata),
        ),
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
