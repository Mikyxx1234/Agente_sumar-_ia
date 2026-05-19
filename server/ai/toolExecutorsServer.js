/**
 * Executores das tools no lado servidor — chamam direto os módulos locais
 * (sem HTTP). Use em conjunto com TOOL_DEFINITIONS.
 *
 * Recebem opcionalmente um `executionContext` (ver
 * `./executionContext.js`) para empurrar usage de sub-chamadas LLM
 * (query rewrite, resumo de inscrição, distribuir humano, embeddings)
 * — assim o dashboard mostra o custo total honesto da execução.
 */

import { runInscricao } from '../inscricaoTool.js'
import { isInscricaoAutomaticaEnabled, matriculaViaConsultorInstruction } from '../inscricaoConfig.js'
import { runDistribuirHumano } from '../distribuirHumanoTool.js'
import { runInscricaoFormStart } from '../inscricaoFormFlow.js'
import { normalizeSalesbotMotivo } from '../kommoSalesbot.js'
import { runBuscarHistorico } from '../memoryTool.js'
import { resolveModel } from './modelRegistry.js'
import { rewriteSearchQuery } from './queryRewrite.js'
import { createNoopExecutionContext } from './executionContext.js'
import { enrichRowContentForRag } from '../../libShared/knowledgeRowFormat.js'
import { searchKnowledgeBase } from './knowledgeSearch.js'

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

/** Legado: FAQ `match_documents_perguntas` (fora das 4 tabelas Sumaré). */
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
  if (!Array.isArray(data) || data.length === 0) {
    return [
      'Nenhum resultado encontrado na base.',
      'INSTRUÇÃO: se o lead pediu um curso específico, faça nova busca com termos da área (buscar_conhecimento). Não diga que o curso não existe. Só cite cursos cujos nomes aparecerem em um CONTEXT com resultados.',
    ].join('\n')
  }

  const ragSource =
    toolName === 'buscar_informacoes'
      ? 'grad_info'
      : toolName === 'buscar_pos'
        ? 'pos_info'
        : toolName === 'buscar_precos'
          ? 'grad_preco'
          : null

  return data
    .map((d) => {
      const base = d?.content || ''
      if (ragSource) {
        const enriched = enrichRowContentForRag(ragSource, d)
        if (toolName === 'buscar_precos') {
          try {
            const sample = JSON.stringify(d?.metadata ?? null).slice(0, 800)
            console.log(`[tool/buscar_precos] sample content="${(d?.content || '').slice(0, 80)}" metadata=${sample}`)
          } catch { /* ignore */ }
        }
        return enriched
      }
      return base
    })
    .join('\n\n---\n\n')
}

function formatInscricaoResult(data) {
  if (!data.ok) {
    if (data.code === 'CURSO_INVALIDO') {
      return [
        data.message || 'Curso inválido.',
        'INSTRUÇÃO: peça ao usuário o nome completo do curso antes de tentar de novo. Não tente chamar a tool com a string atual.',
      ].join('\n')
    }
    if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
    if (data.code === 'KOMMO_LEAD_NOT_FOUND' && data.message) return data.message
    if (data.code === 'MISSING_PARAMS') return data.error || 'Informe curso e tipo de ingresso.'
    // Falhas técnicas: não exposor detalhes ao usuário.
    return [
      'Não foi possível concluir a inscrição agora.',
      'INSTRUÇÃO: peça desculpas ao usuário, diga que vai encaminhar para um consultor e siga conversando normalmente. Não cite IDs ou detalhes técnicos.',
    ].join('\n')
  }
  const lines = [
    data.retorno || 'Lead movido para Aguardando Inscrição.',
    `Curso: ${data.curso}`,
    `Tipo de ingresso: ${data.tipo_ingresso}`,
    'INSTRUÇÃO: confirme ao usuário que o pedido de inscrição foi registrado e que um consultor entrará em contato para finalizar. Tom acolhedor e direto.',
  ]
  return lines.join('\n')
}

function formatDistribuirResult(data) {
  if (!data.ok) {
    if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
    if (data.code === 'KOMMO_LEAD_NOT_FOUND' && data.message) return data.message
    // Em qualquer outro erro, o LLM recebe uma mensagem GENÉRICA com
    // instrução clara — nunca expor pipeline/funil/IDs internos pro
    // cliente. Falhas técnicas viram "consultor entrará em contato em
    // breve" do ponto de vista do usuário.
    if (data.code === 'LEAD_NOT_ELIGIBLE') {
      return [
        'Não foi possível encaminhar para um consultor humano agora.',
        'INSTRUÇÃO: continue ajudando o cliente normalmente e diga que um consultor entrará em contato em breve. Não cite funil, pipeline ou detalhes técnicos.',
      ].join('\n')
    }
    if (data.code === 'DIST_COMERCIAL_NOT_CONFIGURED') {
      return [
        'Distribuição indisponível por configuração interna.',
        'INSTRUÇÃO: peça desculpas brevemente e diga que um consultor entrará em contato em breve.',
      ].join('\n')
    }
    return [
      'Distribuição não executada.',
      'INSTRUÇÃO: continue a conversa normalmente e diga que um consultor entrará em contato em breve. Não cite detalhes técnicos.',
    ].join('\n')
  }
  const lines = [
    data.retorno || 'Distribuição concluída.',
    data.consultor ? `Consultor designado: ${data.consultor}` : null,
  ].filter(Boolean)
  if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
  // Sem `id_consultor` pra o LLM — não traz valor pro cliente final.
  return lines.join('\n')
}

/**
 * Empurra os usages do `_meta` retornado por uma tool dentro do `ctx`.
 * Hoje só `inscricao` e `distribuir_humano` retornam `_meta`.
 */
/** Matrícula → salesbot Formulario_Sum. Pós-formulário → salesbot 49815. */
function resolveDistribuirMotivo(args = {}) {
  if (args.form_completed) return 'matricula_pos_form'
  if (args.motivo ?? args.fluxo) return args.motivo ?? args.fluxo
  const curso = args.curso ?? args.Curso ?? args.nome_curso
  const tipo = args.tipo_ingresso ?? args.tipoIngresso ?? args.ingresso
  if (curso && tipo) return 'matricula'
  return 'consultor'
}

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
    buscar_conhecimento: async ({ query }) =>
      searchKnowledgeBase(env, safeCtx, query, { toolName: 'buscar_conhecimento' }),
    buscar_precos: async ({ query }) =>
      searchKnowledgeBase(env, safeCtx, query, { toolName: 'buscar_precos', intentHint: 'preco' }),
    buscar_informacoes: async ({ query }) =>
      searchKnowledgeBase(env, safeCtx, query, { toolName: 'buscar_informacoes', levelHint: 'grad', intentHint: 'info' }),
    buscar_pos: async ({ query }) =>
      searchKnowledgeBase(env, safeCtx, query, { toolName: 'buscar_pos', levelHint: 'pos', intentHint: 'info' }),
    buscar_perguntas: async ({ query }) => {
      const out = await vectorSearch(env, safeCtx, 'buscar_perguntas', 'match_documents_perguntas', query, 6)
      // Quando o RAG não acha nada, dá pra IA uma instrução explícita
      // pra DISTRIBUIR pra humano em vez de inventar resposta sobre
      // processos internos da empresa (matrícula, dispensa, etc.).
      if (out === 'Nenhum resultado encontrado na base.') {
        return [
          'Nenhum resultado encontrado na base de FAQ para esta pergunta.',
          '',
          'INSTRUÇÃO OBRIGATÓRIA: NÃO invente resposta sobre processos da empresa. NÃO mande o cliente "procurar a faculdade", "ligar para a coordenação", "consultar a secretaria", "verificar com o polo". Quem analisa esse tipo de caso somos NÓS.',
          'Em vez disso, chame a tool distribuir_humano (telefone do Contexto, motivo: "consultor" — salesbot 49777) e responda ao cliente que um consultor entrará em contato em breve para ajudar.',
        ].join('\n')
      }
      return out
    },
    inscricao: async (args) => {
      if (!isInscricaoAutomaticaEnabled(env)) {
        const telefone = args.telefone
        const curso = args.curso ?? args.Curso
        const tipo = args.tipo_ingresso ?? args.tipoIngresso
        if (telefone && curso && tipo) {
          const r = await runInscricaoFormStart(env, {
            telefone,
            id_lead: args.id_lead ?? args.idLead,
            curso,
            tipo_ingresso: tipo,
          })
          return [
            'Fluxo de inscrição: salesbot Formulario_Sum ativado no Kommo.',
            r.ok ? r.message : `Falha: ${r.message || r.result?.error}`,
          ].join('\n')
        }
        return matriculaViaConsultorInstruction(args)
      }
      const r = await runInscricao(env, args)
      absorbToolMeta(safeCtx, r)
      return formatInscricaoResult(r)
    },
    distribuir_humano: async (args) => {
      const motivo = resolveDistribuirMotivo(args)
      const kind = normalizeSalesbotMotivo(motivo)
      if (kind === 'formulario_sum') {
        const r = await runInscricaoFormStart(env, args)
        return [
          'Salesbot Formulario_Sum ativado. Aguarde o lead preencher o formulário — o salesbot 49815 dispara após o retorno.',
          r.ok ? r.message : `Atenção: ${r.message || r.result?.error}`,
        ].join('\n')
      }
      const r = await runDistribuirHumano(env, {
        ...args,
        motivo: kind === 'matricula_pos_form' ? 'matricula_pos_form' : 'consultor',
      })
      absorbToolMeta(safeCtx, r)
      return formatDistribuirResult(r)
    },
    buscar_historico_conversa: async (args) => {
      const out = await runBuscarHistorico(env, args)
      if (!out.ok) return `Não foi possível recuperar o histórico: ${out.error || 'erro'}`
      const body = out.historico || 'Sem histórico de conversa disponível.'
      return [
        'USO INTERNO — leia o histórico abaixo só para contexto. NÃO copie nem cole este bloco na resposta ao lead.',
        '',
        body,
      ].join('\n')
    },
  }
}
