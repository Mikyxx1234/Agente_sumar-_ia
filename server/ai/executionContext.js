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
  // Fila FIFO por tool com info "de auditoria" da última chamada — hoje
  // só guarda o resultado do query rewrite (ver toolExecutorsServer.js).
  // O agentRunner consome um item antes de gravar cada step do toolTrace,
  // permitindo ao ExecutionViewer mostrar "o que a reescrita fez".
  const toolTraceQueues = new Map()
  // Snapshot do histórico de conversa que foi injetado no system
  // prompt do orquestrador. Usado pelo ExecutionViewer pra mostrar
  // "memória usada" e diagnosticar quando a IA "esquece" turnos.
  let historySnapshot = null
  let scopeClassification = null
  const scopeClassifierUsage = []

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

    /**
     * Empilha um trace de "auditoria" associado a uma tool (FIFO).
     * Hoje usado só para a reescrita de query: cada chamada de tool
     * de busca deixa um trace que o agentRunner consome ao montar
     * o step do toolTrace. Assim o ExecutionViewer mostra
     * "Reescrita: 'oi' → 'preço mensalidade curso'".
     */
    recordToolTrace(toolName, trace) {
      if (!toolName || !trace) return
      let q = toolTraceQueues.get(toolName)
      if (!q) { q = []; toolTraceQueues.set(toolName, q) }
      q.push(trace)
    },

    /** Consome (FIFO) o próximo trace pendente para a tool. */
    consumeToolTrace(toolName) {
      const q = toolTraceQueues.get(toolName)
      if (!q || q.length === 0) return null
      return q.shift()
    },

    /**
     * Registra o snapshot do histórico injetado no prompt do
     * orquestrador. `count` total + `preview` com as últimas N
     * mensagens (já truncadas em ~200 chars cada).
     */
    recordHistorySnapshot(snap) {
      if (!snap) return
      historySnapshot = {
        count: Number(snap.count) || 0,
        source: typeof snap.source === 'string' ? snap.source : null,
        preview: Array.isArray(snap.preview) ? snap.preview.slice(0, 12) : [],
      }
    },

    recordScopeClassification(info) {
      if (!info || typeof info !== 'object') return
      scopeClassification = {
        blocked: Boolean(info.blocked),
        source: info.source || null,
        reason: info.reason || null,
        classification: info.classification || null,
      }
      if (info.model && info.usage) {
        pushUsage(scopeClassifierUsage, {
          model: info.model,
          tool: 'scope_classifier',
          usage: info.usage,
        })
      }
    },

    /** Snapshot serializável para `mensagens_ia.ai_meta`. */
    toAiMeta() {
      return {
        queryRewriteUsage: queryRewriteUsage.slice(),
        toolUsage: toolUsage.slice(),
        embeddingsUsage: embeddingsUsage.slice(),
        scopeClassifierUsage: scopeClassifierUsage.slice(),
        scopeClassification,
        history: historySnapshot,
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
    recordToolTrace() {},
    consumeToolTrace() { return null },
    recordHistorySnapshot() {},
    recordScopeClassification() {},
    toAiMeta() {
      return {
        queryRewriteUsage: [],
        toolUsage: [],
        embeddingsUsage: [],
        scopeClassifierUsage: [],
        scopeClassification: null,
        history: null,
      }
    },
  }
}
