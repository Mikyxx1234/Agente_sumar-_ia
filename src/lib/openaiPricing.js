/**
 * Tabela única de preços OpenAI (e modelos relacionados).
 *
 * Valores em USD por 1M tokens. Verifique periodicamente em:
 *   https://openai.com/api/pricing/
 *   https://ai.google.dev/pricing  (Gemini)
 *
 * Convenção: chave do mapa = exatamente o `model` que volta na coluna
 * `mensagens_ia.model` ou `feedback_job_runs.openai_model`.
 *
 * Quando um modelo não está mapeado, usamos o fallback DEFAULT_PRICING
 * (mais barato — gpt-4o-mini) para evitar superestimar custo de
 * execuções com modelo desconhecido. O dashboard avisa visualmente
 * via `pricingFor(model).fallbackUsed = true`.
 */

export const USD_TO_BRL = 5.7

/** USD por 1M tokens. */
export const TOKEN_COSTS_USD_PER_1M = {
  // — OpenAI Chat Completions —
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  // GPT-5 family (lançados 2025). Usados pelo Feedback IA.
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },

  // — OpenAI Embeddings (usado no RAG; não tem output) —
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },

  // — Google Gemini (usado no feedback job) —
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
}

const DEFAULT_PRICING_KEY = 'gpt-4o-mini'

/**
 * Devolve a tarifa de um modelo (ou DEFAULT) e indica se foi fallback.
 * @param {string|null|undefined} model
 * @returns {{ rates: { input: number, output: number }, fallbackUsed: boolean, modelKey: string }}
 */
export function pricingFor(model) {
  const key = String(model || '').trim()
  const rates = TOKEN_COSTS_USD_PER_1M[key]
  if (rates) return { rates, fallbackUsed: false, modelKey: key }
  return {
    rates: TOKEN_COSTS_USD_PER_1M[DEFAULT_PRICING_KEY],
    fallbackUsed: true,
    modelKey: DEFAULT_PRICING_KEY,
  }
}

/**
 * Calcula custo (USD) de uma execução a partir de `usage` e `model`.
 * `usage` deve ter `prompt_tokens` e `completion_tokens` (formato
 * padrão OpenAI). Aceita `prompt_tokens` aliasado por `input_tokens` e
 * `completion_tokens` aliasado por `output_tokens` para Gemini.
 */
export function calcCostUSD(usage, model) {
  const { rates } = pricingFor(model)
  const inputTokens =
    Number(usage?.prompt_tokens) || Number(usage?.input_tokens) || 0
  const outputTokens =
    Number(usage?.completion_tokens) || Number(usage?.output_tokens) || 0
  const inputCost = (inputTokens / 1_000_000) * rates.input
  const outputCost = (outputTokens / 1_000_000) * rates.output
  return inputCost + outputCost
}

/** Mesmo cálculo, em BRL (USD * USD_TO_BRL). */
export function calcCostBRL(usage, model) {
  return calcCostUSD(usage, model) * USD_TO_BRL
}

/**
 * Soma usage de várias chamadas (útil para "sub-execuções" — query
 * rewrite, resumo de inscrição, etc.). Cada item: { usage, model }.
 */
export function calcCostBRLMulti(items) {
  return (items || []).reduce(
    (sum, x) => sum + calcCostBRL(x.usage || {}, x.model),
    0,
  )
}

/** Lista de modelos OpenAI Chat exibíveis em UI (Playground select etc.). */
export const OPENAI_CHAT_MODELS = [
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
]
