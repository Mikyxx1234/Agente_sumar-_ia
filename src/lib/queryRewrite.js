/**
 * Versão client-side (Playground) de `server/ai/queryRewrite.js`.
 *
 * O Playground roda direto no navegador chamando OpenAI com a key do
 * usuário. Pra ele ter PARIDADE com o servidor (mesma lógica de RAG
 * fusion / query rewrite), espelhamos aqui as mesmas regras
 * conservadoras: timeout, JSON validado, fallback p/ a query original
 * em qualquer sinal de dúvida e nunca lançar erro.
 *
 * Diferenças em relação ao server:
 *   - Não há `env`/`resolveModel`: o modelo é passado por arg
 *     (default `gpt-4.1-nano`), e o `apiKey` também.
 *   - Toggle "enabled" também por arg (default true).
 *
 * Retorno em qualquer cenário:
 *   { applied, query, originalQuery, model, usage|null, reason, elapsedMs }
 */

const URL_CHAT = 'https://api.openai.com/v1/chat/completions'
// Timeout curto pra reescrita não virar gargalo no Teste IA.
const TIMEOUT_MS = 2500
const MAX_LEN_OUT = 200
const MIN_LEN_OUT = 3
const DEFAULT_MODEL = 'gpt-4.1-nano'

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
 * @param {{ rawQuery: string, toolName?: string, apiKey: string, model?: string, enabled?: boolean }} input
 */
export async function rewriteSearchQuery({
  rawQuery,
  toolName,
  apiKey,
  model = DEFAULT_MODEL,
  enabled = true,
} = {}) {
  const original = String(rawQuery || '').trim()

  if (!original) {
    return { applied: false, query: original, originalQuery: original, reason: 'empty', model }
  }
  if (!enabled) {
    return { applied: false, query: original, originalQuery: original, reason: 'disabled', model }
  }
  if (!apiKey) {
    return { applied: false, query: original, originalQuery: original, reason: 'no_api_key', model }
  }
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
        max_tokens: 60,
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
