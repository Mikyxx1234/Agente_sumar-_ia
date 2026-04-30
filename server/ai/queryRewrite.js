/**
 * Reescreve a pergunta do cliente em uma "query de busca" mais útil
 * para a busca vetorial (embeddings + RPC match_documents_*).
 *
 * Por que existe:
 *   - Cliente pergunta "ele tá caro?" — embedding disso fica genérico
 *     e a busca de preço não encontra o curso certo.
 *   - Reescrita transforma em "preço mensalidade curso administração"
 *     e a busca acerta o trecho ideal.
 *
 * Princípios CONSERVADORES (não corromper a busca):
 *   - Modelo barato (`gpt-4.1-nano`) com temperatura 0.
 *   - Saída JSON validada com schema.
 *   - **Fallback para a query original** em qualquer sinal de dúvida:
 *       • timeout ou falha de rede
 *       • JSON inválido na saída
 *       • query reescrita vazia ou só whitespace
 *       • query reescrita muito curta (<3 chars)
 *       • query reescrita muito longa (>200 chars)
 *       • o LLM marcou `confident=false`
 *   - Toggle global via env `AI_QUERY_REWRITE_ENABLED=false` desliga
 *     tudo (e a tool usa a query crua direto).
 *
 * Em qualquer cenário a função NUNCA lança — sempre devolve um objeto
 * com a query final, motivo do skip (se houver) e usage do LLM (mesmo
 * em caso de fallback parcial).
 *
 * Uso:
 *   const r = await rewriteSearchQuery(env, { rawQuery, toolName })
 *   r.applied  → true se reescreveu de fato
 *   r.query    → a query a usar na busca (reescrita ou original)
 *   r.usage    → usage OpenAI da chamada (opcional)
 *   r.model    → modelo usado
 *   r.reason   → motivo do skip (quando applied=false)
 */

import { resolveModel } from './modelRegistry.js'

const URL_CHAT = 'https://api.openai.com/v1/chat/completions'
const TIMEOUT_MS = 5000
const MAX_LEN_OUT = 200
const MIN_LEN_OUT = 3

const SYSTEM_PROMPT = `Você reformula a mensagem do cliente em uma "query" curta e direta para
busca vetorial em uma base de conhecimento de um agente comercial educacional.

REGRAS CRÍTICAS:
1. NUNCA invente curso, preço, polo, modalidade ou qualquer fato que o cliente não disse.
2. Se a mensagem do cliente for vaga ("e aí?", "vc tá?", "ok"), marque confident=false e devolva
   exatamente a mensagem original em "query".
3. Se o cliente já fez uma pergunta clara, reescreva em uma query objetiva
   contendo as palavras-chave relevantes. Mantenha o curso/produto/polo
   se ele citou; não substitua por sinônimos genéricos.
4. Saída em PORTUGUÊS, minúsculas, sem pontuação final.
5. Tamanho-alvo: 3 a 15 palavras.
6. NÃO inclua "como" ou "qual é" — só o objeto da busca.

EXEMPLOS:
- Cliente: "ele tá caro?" + tool=buscar_precos → query="preço mensalidade curso", confident=true
- Cliente: "qual a duração do curso de administração?" + tool=buscar_informacoes → query="duração curso administração", confident=true
- Cliente: "tem polo perto de mim?" + tool=buscar_informacoes → query="polo localização modalidade presencial", confident=true
- Cliente: "ok" + tool=buscar_precos → query="ok", confident=false
- Cliente: "🌷" → query="🌷", confident=false

Devolva APENAS um objeto JSON: {"query": string, "confident": boolean, "reason": string}`

/**
 * @param {Record<string,string>} env
 * @param {{ rawQuery: string, toolName?: string }} input
 * @returns {Promise<{
 *   applied: boolean,
 *   query: string,
 *   originalQuery: string,
 *   reason?: string,
 *   model: string,
 *   usage?: object|null,
 *   elapsedMs?: number,
 * }>}
 */
export async function rewriteSearchQuery(env, { rawQuery, toolName } = {}) {
  const original = String(rawQuery || '').trim()
  const model = resolveModel(env, 'query_rewrite', { tool: toolName })

  if (!original) {
    return { applied: false, query: original, originalQuery: original, reason: 'empty', model }
  }

  // Toggle global. Default = enabled.
  const enabled = String(env.AI_QUERY_REWRITE_ENABLED ?? 'true').toLowerCase() !== 'false'
  if (!enabled) {
    return { applied: false, query: original, originalQuery: original, reason: 'disabled', model }
  }

  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) {
    return { applied: false, query: original, originalQuery: original, reason: 'no_api_key', model }
  }

  // Sanity: queries muito longas já são específicas e estão "boas". Se o
  // cliente colou um texto enorme, não vale a pena pagar nano pra
  // resumir em "query curta" — embedding aceita até 8k tokens.
  if (original.length > 500) {
    return { applied: false, query: original, originalQuery: original, reason: 'too_long_in', model }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const startMs = Date.now()
  try {
    const userPrompt =
      `Tool de busca: ${toolName || 'buscar'}\n` +
      `Mensagem do cliente: "${original}"`

    const res = await fetch(URL_CHAT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 100,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    })
    const elapsedMs = Date.now() - startMs

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[queryRewrite] http ${res.status}: ${body.slice(0, 200)}`)
      return { applied: false, query: original, originalQuery: original, reason: `http_${res.status}`, model, elapsedMs }
    }

    const data = await res.json()
    const usage = data?.usage || null
    const raw = data?.choices?.[0]?.message?.content || ''
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { applied: false, query: original, originalQuery: original, reason: 'invalid_json', model, usage, elapsedMs }
    }

    const rewritten = String(parsed?.query || '').trim()
    const confident = parsed?.confident === true

    if (!confident) {
      return { applied: false, query: original, originalQuery: original, reason: 'low_confidence', model, usage, elapsedMs }
    }
    if (!rewritten) {
      return { applied: false, query: original, originalQuery: original, reason: 'empty_rewrite', model, usage, elapsedMs }
    }
    if (rewritten.length < MIN_LEN_OUT) {
      return { applied: false, query: original, originalQuery: original, reason: 'too_short_out', model, usage, elapsedMs }
    }
    if (rewritten.length > MAX_LEN_OUT) {
      return { applied: false, query: original, originalQuery: original, reason: 'too_long_out', model, usage, elapsedMs }
    }
    if (rewritten.toLowerCase() === original.toLowerCase()) {
      // Não é "erro", mas marcar applied=false economiza log.
      return { applied: false, query: original, originalQuery: original, reason: 'noop', model, usage, elapsedMs }
    }

    return {
      applied: true,
      query: rewritten,
      originalQuery: original,
      reason: 'ok',
      model,
      usage,
      elapsedMs,
    }
  } catch (e) {
    const elapsedMs = Date.now() - startMs
    const aborted = e?.name === 'AbortError'
    return {
      applied: false,
      query: original,
      originalQuery: original,
      reason: aborted ? 'timeout' : `error:${e?.message?.slice(0, 80) || 'unknown'}`,
      model,
      elapsedMs,
    }
  } finally {
    clearTimeout(timer)
  }
}
