/**
 * RAG unificado — base vetorial Faculdade Sumaré (pgvector via RPC).
 *
 * RPCs: match_pos_info, match_pos_preco, match_grad_info, match_grad_preco, match_grad_grade_curricular
 */

import { resolveModel } from './modelRegistry.js'
import { rewriteSearchQuery } from './queryRewrite.js'
import { classifyKnowledgeQuery, planKnowledgeRpcs } from '../../libShared/queryClassifier.js'
import { enrichRowContentForRag } from '../../libShared/knowledgeRowFormat.js'
import { COURSE_MORE_INFO_REPLY_RULES, userAsksCourseMoreDetails } from '../../libShared/courseMoreInfo.js'
import { fetchOfferedModalidadesByCourse } from '../sumareCaptacaoCursoStore.js'
import {
  filterKnowledgeRowsByOfficialOffer,
  buildOfficialOfferContextBlock,
} from '../../libShared/cursoOfertaFilter.js'

const INSTITUTION = 'Faculdade Sumaré'

const LEGACY_BRAND_PATTERNS = [
  /\bcruzeiro\b/i,
  /\banhanguera\b/i,
  /\bcruzeiro\s+do\s+sul\b/i,
  /\bsoead\b/i,
  /\bcruzeiro\s+virtual\b/i,
]

export function legacyBrandHitInText(text) {
  const t = String(text || '')
  return LEGACY_BRAND_PATTERNS.some((re) => re.test(t))
}

async function fetchEmbedding(env, text, ctx, toolName) {
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
  if (ctx && data.usage) {
    ctx.recordEmbeddingsUsage({ model, tool: toolName, usage: data.usage })
  }
  const emb = data.data[0].embedding
  if (emb.length !== 1536) {
    console.warn(
      `[knowledgeSearch] embedding tem ${emb.length} dims (esperado 1536 p/ funções match_* no Supabase). Verifique OPENAI_MODEL_EMBEDDINGS.`,
    )
  }
  return emb
}

async function callMatchRpc(env, rpcName, embedding) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!url || !key) throw new Error('Supabase não configurado')

  const res = await fetch(`${url}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
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
  let data
  try {
    data = JSON.parse(bodyText)
  } catch {
    throw new Error(`Supabase RPC ${rpcName}: resposta não-JSON`)
  }
  if (!Array.isArray(data)) return []
  return data
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

const SUMARÉ_REPLY_RULES = [
  '',
  'INSTRUÇÃO OBRIGATÓRIA:',
  `Você é um agente comercial da ${INSTITUTION}. Responda usando somente o CONTEXT acima.`,
  'Não use informações de outras instituições (ex.: Cruzeiro, Anhanguera, SOEAD), mesmo que existam em materiais antigos do projeto.',
  'CURSO PEDIDO AUSENTE DO CONTEXT: se o lead perguntou por um curso específico e o nome dele NÃO aparece no CONTEXT, NÃO diga que não encontrou ou que não existe. Faça nova busca por área e sugira APENAS cursos cujos nomes estejam no CONTEXT (2–3 opções), sem preço/detalhes de curso que não esteja no CONTEXT.',
  'NUNCA cite nome de curso que não esteja escrito no CONTEXT (não invente programas "parecidos").',
  'MODALIDADE: se o bloco OFERTA OFICIAL listar modalidade(s) para um curso, cite SOMENTE essa(s) — ignore trechos do CONTEXT com modalidade diferente (dados antigos do site/RAG).',
  'Se o CONTEXT não tiver informação suficiente (e não for só curso inexistente), ofereça consultor (distribuir_humano) quando fizer sentido.',
  'Se a pergunta puder ser graduação ou pós-graduação e o CONTEXT não deixar claro, peça uma confirmação curta: "Você quer informações sobre graduação ou pós-graduação?"',
  'Não mencione Supabase, RAG, embedding ou tabelas para o lead.',
].join('\n')

/**
 * @param {Record<string,string>} env
 * @param {import('./executionContext.js').ExecutionContext|null} ctx
 * @param {string} question
 * @param {{ toolName?: string, levelHint?: 'pos'|'grad'|null, intentHint?: 'preco'|'info'|'mista'|null }} [opts]
 * @returns {Promise<string>}
 */
export async function searchKnowledgeBase(env, ctx, question, opts = {}) {
  const toolName = opts.toolName || 'buscar_conhecimento'
  const q0 = String(question || '').trim()
  const legacyInQuestion = legacyBrandHitInText(q0)

  const wantsCourseMoreDetails =
    opts.wantsCourseMoreDetails === true || userAsksCourseMoreDetails(q0)
  const classified = classifyKnowledgeQuery(q0)
  const plan = planKnowledgeRpcs(classified, {
    levelHint: opts.levelHint ?? null,
    intentHint: wantsCourseMoreDetails && !opts.intentHint ? 'mista' : opts.intentHint ?? null,
  })

  console.log(`[knowledgeSearch] pergunta="${q0.slice(0, 200)}${q0.length > 200 ? '…' : ''}"`)
  console.log(`[knowledgeSearch] instituição_ativa=${INSTITUTION}`)
  console.log(`[knowledgeSearch] tipo_detectado=${classified.level} intenção=${classified.intent}`)
  if (opts.levelHint || opts.intentHint) {
    console.log(`[knowledgeSearch] hints level=${opts.levelHint ?? '—'} intent=${opts.intentHint ?? '—'}`)
  }
  console.log(`[knowledgeSearch] RPCs planejadas: ${plan.map((p) => p.rpc).join(', ')}`)
  if (legacyInQuestion) {
    console.warn('[knowledgeSearch] aviso: a pergunta do usuário contém possível referência a marca/instituição antiga (Cruzeiro/Anhanguera/SOEAD).')
  }

  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!url || !key) {
    return 'Supabase não configurado no servidor — não é possível consultar a base da Faculdade Sumaré.'
  }

  const rw = await rewriteSearchQuery(env, { rawQuery: q0, toolName })
  if (ctx && rw.usage) {
    ctx.recordQueryRewriteUsage({ model: rw.model, tool: toolName, usage: rw.usage })
  }
  const finalQuery = rw.applied ? rw.query : q0
  if (ctx) {
    ctx.recordToolTrace(toolName, {
      applied: rw.applied,
      query: finalQuery,
      originalQuery: rw.originalQuery || q0,
      model: rw.model,
      reason: rw.reason || null,
      usage: rw.usage || null,
      elapsedMs: rw.elapsedMs || 0,
    })
  }
  if (rw.applied) {
    console.log(`[knowledgeSearch] queryRewrite: "${q0}" → "${finalQuery}"`)
  } else if (rw.reason) {
    console.log(`[knowledgeSearch] queryRewrite skip: ${rw.reason}`)
  }

  const embedding = await fetchEmbedding(env, finalQuery, ctx, toolName)

  /** @type {Array<{ source: string, id: number, content: string, metadata: object, similarity: number }>} */
  const merged = []

  for (const { rpc, source } of plan) {
    try {
      const chunk = await callMatchRpc(env, rpc, embedding)
      console.log(`[knowledgeSearch] RPC ${rpc} → ${chunk.length} linhas`)
      for (const raw of chunk) {
        merged.push(normalizeRow(source, raw))
      }
    } catch (e) {
      const msg = String(e?.message || e)
      if (rpc === 'match_grad_grade_curricular' && /\b404\b/.test(msg)) {
        console.warn(`[knowledgeSearch] RPC ${rpc} indisponível (tabela dedicada ausente) — usando grad_info`)
        continue
      }
      console.error(`[knowledgeSearch] RPC ${rpc} falhou:`, msg)
      throw e
    }
  }

  merged.sort((a, b) => b.similarity - a.similarity)

  const ofertaMap = await fetchOfferedModalidadesByCourse(env)
  const { rows: filtered, removed } = filterKnowledgeRowsByOfficialOffer(merged, ofertaMap)
  if (removed.length) {
    console.log(
      `[knowledgeSearch] filtro oferta: removidas ${removed.length} linhas (modalidade obsoleta) — ex.: ${removed
        .slice(0, 3)
        .map((r) => `${r.key}/${r.mod}`)
        .join(', ')}`,
    )
  }

  const bestSim = filtered.length ? filtered[0].similarity : null
  const top = filtered.slice(0, 18)

  console.log(
    `[knowledgeSearch] consolidado: ${filtered.length} linhas (de ${merged.length}); melhor_similarity=${bestSim != null ? bestSim.toFixed(4) : 'n/a'}`,
  )

  if (top.length === 0) {
    const amb = classified.level === 'ambiguous'
    const tail = amb
      ? '\n\nO sistema não encontrou trechos na base. Se a dúvida puder ser sobre graduação ou pós-graduação, pergunte qual dos dois o lead prefere antes de insistir em outra busca.'
      : ''
    return [
      `Nenhum trecho relevante foi encontrado na base de conhecimento da ${INSTITUTION} para esta consulta.`,
      'Se o lead pediu um curso específico: faça nova busca com termos da área e sugira somente cursos que aparecerem no CONTEXT — sem dizer que o curso pedido não existe.',
      SUMARÉ_REPLY_RULES,
      tail,
    ].join('\n')
  }

  const ofertaBlock = buildOfficialOfferContextBlock(top, ofertaMap, q0)
  const block = buildContextBlock(top)
  const rules = wantsCourseMoreDetails
    ? [SUMARÉ_REPLY_RULES, COURSE_MORE_INFO_REPLY_RULES].join('\n')
    : SUMARÉ_REPLY_RULES
  return [[ofertaBlock, block].filter(Boolean).join('\n\n'), rules].join('\n')
}

/**
 * Loga se o texto agregado de prompts (ex.: APAGAR.txt) ainda cita marcas antigas.
 * @param {string} combinedPromptText
 */
export function logLegacyBrandScanInPrompts(combinedPromptText) {
  const t = String(combinedPromptText || '')
  if (!t.trim()) return
  if (legacyBrandHitInText(t)) {
    console.warn(
      '[prompts/legacy-brand] O texto agregado de APAGAR.txt (prompts n8n) ainda contém menções a Cruzeiro/Anhanguera/SOEAD. ' +
        'O override do agente prioriza Faculdade Sumaré e CONTEXT do RAG — revise o arquivo quando possível.',
    )
  }
}
