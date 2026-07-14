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
import { userAsksCourseMoreDetails } from '../../libShared/courseMoreInfo.js'
import {
  runEnviarFormSumarInscricao,
  runRegistrarPoloInscricao,
  runRegistrarTransferencia,
  runConfirmarRecebimentoFormulario,
} from '../inscricaoActionTools.js'
import { runEnviarGradePdf } from '../gradeCurricularActionTools.js'
import { startChannelExitConfirm } from '../humanHandoffFlow.js'
import { buildFacultyContactRedirectReply } from '../../libShared/humanHandoffHeuristics.js'

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

function formatInscricaoResult(data, pushName) {
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
    // Falhas técnicas: não expor detalhes ao usuário nem prometer consultor ativo.
    return [
      'Não foi possível concluir a inscrição agora.',
      `INSTRUÇÃO: NÃO prometa que um consultor entrará em contato. Responda ao lead com este texto (pode ajustar levemente o tom):\n\n${buildFacultyContactRedirectReply({ pushName })}`,
    ].join('\n')
  }
  const lines = [
    data.retorno || 'Lead movido para Aguardando Inscrição.',
    `Curso: ${data.curso}`,
    `Tipo de ingresso: ${data.tipo_ingresso}`,
    'INSTRUÇÃO: confirme ao usuário que o pedido de inscrição foi registrado. NÃO prometa que um consultor entrará em contato ativamente — apenas confirme o registro em tom acolhedor e direto.',
  ]
  return lines.join('\n')
}

function formatDistribuirResult(data, pushName) {
  if (!data.ok) {
    if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
    if (data.code === 'KOMMO_LEAD_NOT_FOUND' && data.message) return data.message
    // Em qualquer outro erro, o LLM recebe uma mensagem GENÉRICA com
    // instrução clara — nunca expor pipeline/funil/IDs internos pro
    // cliente. Falhas técnicas viram o redirecionamento canônico pro
    // atendimento oficial da Faculdade — nunca "consultor entrará em contato".
    if (data.code === 'LEAD_NOT_ELIGIBLE') {
      return [
        'Não foi possível encaminhar o atendimento agora.',
        `INSTRUÇÃO: NÃO prometa consultor ativo. Responda ao lead com este texto (pode ajustar levemente o tom):\n\n${buildFacultyContactRedirectReply({ pushName })}`,
      ].join('\n')
    }
    if (data.code === 'DIST_COMERCIAL_NOT_CONFIGURED') {
      return [
        'Distribuição indisponível por configuração interna.',
        `INSTRUÇÃO: peça desculpas brevemente. NÃO prometa consultor ativo — use este texto:\n\n${buildFacultyContactRedirectReply({ pushName })}`,
      ].join('\n')
    }
    return [
      'Distribuição não executada.',
      `INSTRUÇÃO: NÃO prometa consultor ativo. Responda ao lead com este texto:\n\n${buildFacultyContactRedirectReply({ pushName })}`,
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
 * @param {object} [flowCtx]
 *   Contexto da execução atual repassado às tools de ação de inscrição
 *   (telefone, leadId, pushName, executionId, model, t0). Permite ao
 *   executor reusar dados que o orquestrador já resolveu, sem refazer lookups.
 */
export function buildToolExecutors(env, ctx, flowCtx = {}) {
  const safeCtx = ctx || createNoopExecutionContext()
  const wantsMoreFromFlow =
    flowCtx.wantsCourseMoreDetails === true ||
    userAsksCourseMoreDetails(flowCtx.userMessage || '')
  const knowledgeOpts = (toolName, extra = {}) => ({
    toolName,
    wantsCourseMoreDetails: wantsMoreFromFlow,
    ...extra,
  })
  return {
    buscar_conhecimento: async ({ query }) =>
      searchKnowledgeBase(env, safeCtx, query, knowledgeOpts('buscar_conhecimento')),
    buscar_precos: async ({ query }) =>
      searchKnowledgeBase(env, safeCtx, query, knowledgeOpts('buscar_precos', { intentHint: 'preco' })),
    buscar_informacoes: async ({ query }) =>
      searchKnowledgeBase(
        env,
        safeCtx,
        query,
        knowledgeOpts('buscar_informacoes', { levelHint: 'grad', intentHint: 'info' }),
      ),
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
          'INSTRUÇÃO: NÃO invente processos internos. Se for dúvida sobre CURSO, valores ou matrícula, tente buscar_conhecimento com o nome do curso antes de encaminhar.',
          'Só chame distribuir_humano se for processo administrativo raro sem resposta na base E o lead já esgotou as opções — ou se pediu humano explicitamente.',
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
      return formatInscricaoResult(r, flowCtx.pushName)
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
      if (kind === 'matricula_pos_form') {
        const r = await runDistribuirHumano(env, { ...args, motivo: 'matricula_pos_form' })
        absorbToolMeta(safeCtx, r)
        return formatDistribuirResult(r, flowCtx.pushName)
      }
      // Pedido de humano / dúvida sem solução: NÃO ativa mais salesbot.
      // Fluxo de saída do canal: pergunta de confirmação → se o lead
      // confirmar, o sistema envia os links oficiais e move pra fila 143.
      const telefone = args?.telefone || flowCtx.telefone
      const result = await startChannelExitConfirm(env, {
        telefone,
        leadId: args?.id_lead ?? args?.idLead ?? flowCtx.leadId,
        executionId: flowCtx.executionId,
        model: flowCtx.model,
        pushName: flowCtx.pushName,
        t0: flowCtx.t0,
      })
      return [
        'Fluxo de saída do canal iniciado (NENHUM consultor/salesbot foi acionado).',
        'INSTRUÇÃO: responda ao lead EXATAMENTE com a pergunta abaixo, sem prometer consultor nem contato da equipe:',
        '',
        result.reply,
      ].join('\n')
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
    enviar_form_sumar_inscricao: async (args) =>
      runEnviarFormSumarInscricao(env, args, flowCtx),
    registrar_polo_inscricao: async (args) =>
      runRegistrarPoloInscricao(env, args, flowCtx),
    registrar_transferencia: async (args) =>
      runRegistrarTransferencia(env, args, flowCtx),
    confirmar_recebimento_formulario: async (args) =>
      runConfirmarRecebimentoFormulario(env, args, flowCtx),
    enviar_grade_pdf: async (args) => runEnviarGradePdf(env, args, flowCtx),
  }
}
