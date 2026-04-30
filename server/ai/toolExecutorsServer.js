/**
 * Executores das tools no lado servidor — chamam direto os módulos locais
 * (sem HTTP). Use em conjunto com TOOL_DEFINITIONS.
 *
 * Recebem opcionalmente um `executionContext` (ver
 * `./executionContext.js`) para empurrar usage de sub-chamadas LLM
 * (query rewrite, resumo de inscrição, distribuir humano, embeddings)
 * — assim o dashboard mostra o custo total honesto da execução.
 */

import { runNearestPolo } from '../locationTool.js'
import { runInscricao } from '../inscricaoTool.js'
import { runDistribuirHumano } from '../distribuirHumanoTool.js'
import { runBuscarHistorico } from '../memoryTool.js'
import { resolveModel } from './modelRegistry.js'
import { rewriteSearchQuery } from './queryRewrite.js'
import { createNoopExecutionContext } from './executionContext.js'

async function getEmbedding(env, text, ctx, toolName) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  const model = resolveModel(env, 'embeddings')
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: text }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Embedding ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  // Embeddings devolvem usage.prompt_tokens (e total_tokens), sem
  // completion_tokens. Empurra no aiMeta pra contabilizar custo.
  if (ctx && data.usage) {
    ctx.recordEmbeddingsUsage({ model, tool: toolName, usage: data.usage })
  }
  return data.data[0].embedding
}

async function vectorSearch(env, ctx, toolName, rpcName, query, matchCount = 10) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!url || !key) return 'Supabase não configurado no servidor.'

  // Etapa 1 — opcional: reescreve a pergunta do cliente em uma query
  // melhor antes da busca vetorial. Conservadora: fallback p/ original
  // em qualquer sinal de dúvida (ver server/ai/queryRewrite.js).
  const rw = await rewriteSearchQuery(env, { rawQuery: query, toolName })
  if (ctx && rw.usage) {
    ctx.recordQueryRewriteUsage({ model: rw.model, tool: toolName, usage: rw.usage })
  }
  const finalQuery = rw.applied ? rw.query : query
  if (rw.applied) {
    console.log(`[tool/${toolName}] queryRewrite: "${query}" → "${finalQuery}"`)
  } else if (rw.reason) {
    console.log(`[tool/${toolName}] queryRewrite skip: ${rw.reason}`)
  }
  // Empilha o trace pra o agentRunner colocar dentro do step.queryRewrite
  // — assim a aba "Execuções" mostra exatamente o que a reescrita fez.
  if (ctx) {
    ctx.recordToolTrace(toolName, {
      applied: rw.applied,
      query: finalQuery,
      originalQuery: rw.originalQuery || query,
      model: rw.model,
      reason: rw.reason || null,
      usage: rw.usage || null,
      elapsedMs: rw.elapsedMs || 0,
    })
  }

  const embedding = await getEmbedding(env, finalQuery, ctx, toolName)
  const res = await fetch(`${url}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query_embedding: embedding, filter: {}, match_count: matchCount }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase RPC ${rpcName} ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  if (!Array.isArray(data) || data.length === 0) return 'Nenhum resultado encontrado na base.'
  return data.map((d) => d.content).join('\n\n---\n\n')
}

function formatInscricaoResult(data) {
  if (!data.ok) {
    if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
    if (data.code === 'MISSING_PARAMS') return data.error || 'Informe curso e tipo de ingresso.'
    return `Inscrição não executada: ${data.error || data.message || data.code || 'erro'}`
  }
  const lines = [data.retorno || 'Inscrição processada.', `Curso: ${data.curso}`, `Tipo de ingresso: ${data.tipo_ingresso}`]
  if (data.destino === 'aguardando_inscricao') lines.push('Destino no CRM: Aguardando Inscrição.')
  if (data.destino === 'atendimento') lines.push('Destino no CRM: atendimento (consultor).')
  if (data.missing_fields?.length) lines.push(`Pendências: ${data.missing_fields.join(', ')}`)
  if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
  if (data.warnings?.length) lines.push(`Avisos: ${data.warnings.join(' | ')}`)
  return lines.join('\n')
}

function formatDistribuirResult(data) {
  if (!data.ok) {
    if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
    if (data.code === 'LEAD_NOT_ELIGIBLE' && data.message) return data.message
    if (data.code === 'DIST_COMERCIAL_NOT_CONFIGURED') return data.error
    return `Distribuição não executada: ${data.error || data.message || data.code || 'erro'}`
  }
  const lines = [
    data.retorno || 'Distribuição concluída.',
    data.consultor ? `Consultor: ${data.consultor}` : null,
    data.id_consultor != null ? `ID consultor (Kommo): ${data.id_consultor}` : null,
  ].filter(Boolean)
  if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
  if (data.warnings?.length) lines.push(`Avisos: ${data.warnings.join(' | ')}`)
  return lines.join('\n')
}

function formatLocationResult(data) {
  if (!data.ok) return `Não foi possível encontrar o polo: ${data.error || 'erro'}`
  // Localização vaga (ex.: "Zona Leste", "centro", só cidade): não devolve
  // tempo/distância — eles seriam calculados de um ponto arbitrário e
  // podem enganar o cliente. Em vez disso, mandamos uma INSTRUÇÃO
  // explícita pra o orquestrador pedir endereço/CEP antes de prometer
  // qualquer coisa.
  if (data.imprecise) {
    const polo = data.polo_provavel || 'Polo'
    const endereco = data.rua_do_polo ? `\nEndereço do polo: ${data.rua_do_polo}` : ''
    return [
      'ATENÇÃO — LOCALIZAÇÃO IMPRECISA:',
      `A localização informada${data.origem_imprecisa ? ` ("${data.origem_imprecisa}")` : ''} é uma área genérica, não um endereço exato. NÃO É POSSÍVEL calcular tempo nem distância confiáveis.`,
      '',
      `Polo provável dessa região: ${polo}${endereco}`,
      '',
      'INSTRUÇÃO PARA O ATENDIMENTO:',
      '1. PEÇA ao cliente o endereço completo (rua e número) ou o CEP antes de informar tempo/rota.',
      '2. Caso o cliente prefira NÃO informar, pode mencionar APENAS o nome do polo provável acima — NUNCA cite tempo ou distância para uma localização imprecisa.',
      '3. Não invente tempo, distância ou link de rota.',
    ].join('\n')
  }
  return [
    `Polo mais próximo: ${data.polo_mais_proximo}`,
    `Endereço do polo: ${data.rua_do_polo}`,
    `Tempo estimado (${data.modo_transporte}): ${data.tempo_estimado}`,
    data.distancia ? `Distância: ${data.distancia}` : null,
    `Rota: ${data.link_rota_google}`,
    data.origem_endereco ? `Endereço reconhecido: ${data.origem_endereco}` : null,
  ].filter(Boolean).join('\n')
}

/**
 * Empurra os usages do `_meta` retornado por uma tool dentro do `ctx`.
 * Hoje só `inscricao` e `distribuir_humano` retornam `_meta`.
 */
function absorbToolMeta(ctx, raw) {
  if (!ctx || !raw || typeof raw !== 'object' || !raw._meta) return
  const meta = raw._meta
  if (Array.isArray(meta.toolUsage)) {
    for (const u of meta.toolUsage) ctx.recordToolUsage(u)
  }
  if (Array.isArray(meta.queryRewriteUsage)) {
    for (const u of meta.queryRewriteUsage) ctx.recordQueryRewriteUsage(u)
  }
  if (Array.isArray(meta.embeddingsUsage)) {
    for (const u of meta.embeddingsUsage) ctx.recordEmbeddingsUsage(u)
  }
}

/**
 * @param {Record<string,string>} env
 * @param {ReturnType<typeof import('./executionContext.js').createExecutionContext>} [ctx]
 *   Opcional. Quando passado, sub-usages (query rewrite, embeddings,
 *   resumos de tools) são acumulados pra dashboard. Sem ctx, vira no-op.
 */
export function buildToolExecutors(env, ctx) {
  const safeCtx = ctx || createNoopExecutionContext()
  return {
    buscar_precos: async ({ query }) =>
      vectorSearch(env, safeCtx, 'buscar_precos', 'match_documents_precos', query, 8),
    buscar_informacoes: async ({ query }) =>
      vectorSearch(env, safeCtx, 'buscar_informacoes', 'match_documents', query, 15),
    buscar_pos: async ({ query }) =>
      vectorSearch(env, safeCtx, 'buscar_pos', 'match_documents_pos', query, 8),
    buscar_perguntas: async ({ query }) =>
      vectorSearch(env, safeCtx, 'buscar_perguntas', 'match_documents_perguntas', query, 6),
    localizacao: async (args) => formatLocationResult(await runNearestPolo(env, args)),
    inscricao: async (args) => {
      const r = await runInscricao(env, args)
      absorbToolMeta(safeCtx, r)
      return formatInscricaoResult(r)
    },
    distribuir_humano: async (args) => {
      const r = await runDistribuirHumano(env, args)
      absorbToolMeta(safeCtx, r)
      return formatDistribuirResult(r)
    },
    buscar_historico_conversa: async (args) => {
      const out = await runBuscarHistorico(env, args)
      if (!out.ok) return `Não foi possível recuperar o histórico: ${out.error || 'erro'}`
      return out.historico || 'Sem histórico de conversa disponível.'
    },
  }
}
