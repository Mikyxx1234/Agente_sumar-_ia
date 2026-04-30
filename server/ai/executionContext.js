/**
 * Contexto compartilhado entre o orquestrador (agentRunner) e as tools.
 * Serve para coletar usage de "sub-chamadas" LLM que acontecem dentro
 * das tools (query rewrite, resumo de inscrição, distribuir humano,
 * embeddings) — assim o dashboard mostra o **custo real** da
 * conversa, não só o do orquestrador.
 *
 * Cada item de usage segue o formato:
 *   { model: 'gpt-4.1-nano', usage: { prompt_tokens, completion_tokens, total_tokens } }
 *
 * As listas viram parte de `runAgent.return.aiMeta` e são persistidas
 * em `mensagens_ia.ai_meta` (JSON) por `executionTelemetry.saveExecution`.
 *
 * Uso típico (server side):
 *
 *   const ctx = createExecutionContext()
 *   const executors = buildToolExecutors(env, ctx)  // tools recebem ctx
 *   // ... loop normal do agente ...
 *   return { ..., aiMeta: ctx.toAiMeta() }
 *
 * Uso dentro de uma tool:
 *
 *   ctx.recordToolUsage({ model, usage, tool: 'inscricao' })
 *   ctx.recordQueryRewriteUsage({ model, usage, tool: 'buscar_precos' })
 *   ctx.recordEmbeddingsUsage({ model, usage, tool: 'buscar_precos' })
 */

export function createExecutionContext() {
  const queryRewriteUsage = []
  const toolUsage = []
  const embeddingsUsage = []

  function pushUsage(arr, info) {
    if (!info || !info.model) return
    const u = info.usage || {}
    if (
      !u.prompt_tokens && !u.completion_tokens &&
      !u.total_tokens && !u.input_tokens && !u.output_tokens
    ) {
      return
    }
    arr.push({
      model: info.model,
      tool: info.tool || null,
      usage: {
        prompt_tokens: Number(u.prompt_tokens) || Number(u.input_tokens) || 0,
        completion_tokens: Number(u.completion_tokens) || Number(u.output_tokens) || 0,
        total_tokens:
          Number(u.total_tokens) ||
          ((Number(u.prompt_tokens) || Number(u.input_tokens) || 0) +
            (Number(u.completion_tokens) || Number(u.output_tokens) || 0)),
      },
    })
  }

  return {
    recordQueryRewriteUsage(info) { pushUsage(queryRewriteUsage, info) },
    recordToolUsage(info) { pushUsage(toolUsage, info) },
    recordEmbeddingsUsage(info) { pushUsage(embeddingsUsage, info) },

    /** Snapshot serializável para `mensagens_ia.ai_meta`. */
    toAiMeta() {
      return {
        queryRewriteUsage: queryRewriteUsage.slice(),
        toolUsage: toolUsage.slice(),
        embeddingsUsage: embeddingsUsage.slice(),
      }
    },
  }
}

/** Context "no-op": ignora silenciosamente. Útil em testes/scripts. */
export function createNoopExecutionContext() {
  return {
    recordQueryRewriteUsage() {},
    recordToolUsage() {},
    recordEmbeddingsUsage() {},
    toAiMeta() {
      return { queryRewriteUsage: [], toolUsage: [], embeddingsUsage: [] }
    },
  }
}
