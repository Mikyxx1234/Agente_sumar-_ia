/**
 * RAG Sumaré no browser (Playground) — mesma lógica de `server/ai/knowledgeSearch.js`,
 * usando proxy `/api/supabase` e OpenAI com a chave do Playground.
 */

import { rewriteSearchQuery } from './queryRewrite'
import { classifyKnowledgeQuery, planKnowledgeRpcs } from '../../libShared/queryClassifier.js'
import { enrichRowContentForRag } from '../../libShared/knowledgeRowFormat.js'

const BASE = '/api/supabase'
const INSTITUTION = 'Faculdade Sumaré'

const SUMARÉ_REPLY_RULES = [
  '',
  'INSTRUÇÃO OBRIGATÓRIA:',
  `Você é um agente comercial da ${INSTITUTION}. Responda usando somente o CONTEXT acima.`,
  'Não use informações de outras instituições (ex.: Cruzeiro, Anhanguera, SOEAD), mesmo que existam em materiais antigos do projeto.',
  'Se o CONTEXT não tiver informação suficiente, diga claramente que não encontrou essa informação na base e ofereça ajuda (ex.: consultor via distribuir_humano) quando fizer sentido.',
  'Se a pergunta puder ser graduação ou pós-graduação e o CONTEXT não deixar claro, peça uma confirmação curta: "Você quer informações sobre graduação ou pós-graduação?"',
  'Não mencione Supabase, RAG, embedding ou tabelas para o lead.',
].join('\n')

async function getEmbedding(text, apiKey) {
  const model = 'text-embedding-3-small'
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: text }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Embedding HTTP ${res.status}`)
  }
  const data = await res.json()
  return {
    embedding: data.data[0].embedding,
    usage: data.usage || null,
    model,
  }
}

async function callRpc(rpcName, embedding) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query_embedding: embedding,
      match_count: 5,
      filter: {},
    }),
  })
  const bodyText = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`Supabase RPC ${rpcName} ${res.status}: ${bodyText.slice(0, 240)}`)
  }
  const data = JSON.parse(bodyText)
  return Array.isArray(data) ? data : []
}

function normalizeRow(source, raw) {
  const id = Number(raw?.id)
  const similarity = typeof raw?.similarity === 'number' ? raw.similarity : Number(raw?.similarity) || 0
  return {
    source,
    id: Number.isFinite(id) ? id : 0,
    content: String(raw?.content ?? ''),
    metadata: raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    similarity,
  }
}

function buildContextBlock(rows) {
  const lines = ['CONTEXT:']
  for (const r of rows) {
    const sim = typeof r.similarity === 'number' ? r.similarity.toFixed(4) : String(r.similarity)
    const body = enrichRowContentForRag(r.source, { content: r.content, metadata: r.metadata })
    lines.push('')
    lines.push(`[fonte: ${r.source} | similarity: ${sim}]`)
    lines.push(body)
  }
  return lines.join('\n')
}

/**
 * @param {string} query
 * @param {string} apiKey OpenAI
 * @param {object|null} traceCollector
 * @param {{ toolName?: string, levelHint?: 'pos'|'grad'|null, intentHint?: 'preco'|'info'|'mista'|null }} [opts]
 */
export async function runKnowledgeSearchPlayground(query, apiKey, traceCollector, opts = {}) {
  const toolName = opts.toolName || 'buscar_conhecimento'
  const q0 = String(query || '').trim()
  const classified = classifyKnowledgeQuery(q0)
  const plan = planKnowledgeRpcs(classified, {
    levelHint: opts.levelHint ?? null,
    intentHint: opts.intentHint ?? null,
  })

  console.log(`[knowledgeSearch/playground] pergunta="${q0.slice(0, 160)}" tipo=${classified.level} intent=${classified.intent}`)
  console.log(`[knowledgeSearch/playground] RPCs: ${plan.map((p) => p.rpc).join(', ')}`)

  const rw = await rewriteSearchQuery({
    rawQuery: q0,
    toolName,
    apiKey,
    model: 'gpt-4.1-nano',
    enabled: true,
  })
  if (traceCollector) traceCollector.queryRewrite = rw
  const finalQuery = rw.applied ? rw.query : q0

  const emb = await getEmbedding(finalQuery, apiKey)
  if (traceCollector && emb.usage) {
    traceCollector.embeddingsUsage = { model: emb.model, usage: emb.usage }
  }

  const merged = []
  for (const { rpc, source } of plan) {
    const chunk = await callRpc(rpc, emb.embedding)
    console.log(`[knowledgeSearch/playground] ${rpc} → ${chunk.length}`)
    for (const raw of chunk) merged.push(normalizeRow(source, raw))
  }
  merged.sort((a, b) => b.similarity - a.similarity)
  const top = merged.slice(0, 18)

  if (top.length === 0) {
    return [
      `Nenhum trecho relevante foi encontrado na base de conhecimento da ${INSTITUTION} para esta consulta.`,
      SUMARÉ_REPLY_RULES,
    ].join('\n')
  }
  return [buildContextBlock(top), SUMARÉ_REPLY_RULES].join('\n')
}
