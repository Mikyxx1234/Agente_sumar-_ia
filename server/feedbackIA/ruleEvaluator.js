/**
 * Feedback IA — avaliador automático contra Regras 1-22.
 *
 * Para cada conversa (todas as `mensagens_ia` de um lead), monta uma
 * transcrição, envia ao modelo configurado (papel `rules_eval`,
 * default `gpt-5`) junto com o texto exato das regras do override em
 * produção, e força saída JSON estruturada (`response_format:
 * json_schema`) com:
 *
 *   - verdict ∈ {APROVADO, PARCIAL, REPROVADO}
 *   - score ∈ [0..10]
 *   - per_rule: array de { rule_id, ok, severity, evidence, suggestion? }
 *   - suggestion_text, suggested_rule_id, suggested_new_body
 *
 * Persiste em `ai_rule_evaluations` (idempotente via conversation_key).
 *
 * NÃO aplica patch automaticamente — sugestão fica em status "pending"
 * para revisão humana (Fase 2).
 */

import { resolveModel, getModelRegistrySnapshot } from '../ai/modelRegistry.js'
import { getAgentRulesText, AGENT_RULES_CATALOG } from '../ai/promptsLoader.js'
import {
  insertEvaluation,
  listExecutionsForLead,
} from './evaluationStore.js'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
// gpt-5 + contexto grande (22 regras + transcrição até 60 turnos + JSON
// Schema estrito) pode legitimamente passar de 2-3 min antes de devolver
// a resposta completa. Timeout abaixo é o teto absoluto — passou disso,
// a chamada vira erro técnico (não é reprovação real do agente).
const OPENAI_TIMEOUT_MS = 300_000

// Conversas muito longas estouram contexto e custam caro. Capamos a
// transcrição em primeiros + últimos turnos. Mantém mais do final
// (decisão final do funil é o que importa mais).
const MAX_TURNS_INLINE = 60
const KEEP_HEAD_TURNS = 15
const KEEP_TAIL_TURNS = 45

// Falhas transitórias (timeout, 5xx, rate limit, rede) são retentadas
// antes de marcar como erro técnico. Backoff exponencial: 2s, 4s, 8s.
const MAX_EVAL_ATTEMPTS = 3
const RETRY_BASE_MS = 2_000

function getApiKey(env) {
  return env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY || ''
}

function renderTurn(ex) {
  const ts = ex.created_at || ''
  const user = (ex.user_message || '').toString().trim()
  const bot = (ex.response || '').toString().trim()
  if (!user && !bot) return null
  const lines = [`--- turno ${ts} ---`]
  if (user) lines.push(`USUÁRIO: ${user}`)
  if (bot) lines.push(`IA: ${bot}`)
  const tools = Array.isArray(ex.tool_calls) ? ex.tool_calls : []
  if (tools.length > 0) {
    const names = tools.map((t) => t?.name || t?.function?.name).filter(Boolean)
    if (names.length) lines.push(`(IA chamou tools: ${names.join(', ')})`)
  }
  return lines.join('\n')
}

function buildConversationTranscript(executions) {
  if (executions.length <= MAX_TURNS_INLINE) {
    return executions.map(renderTurn).filter(Boolean).join('\n')
  }
  // Conversa longa: head + placeholder + tail.
  const head = executions.slice(0, KEEP_HEAD_TURNS).map(renderTurn).filter(Boolean)
  const tail = executions.slice(-KEEP_TAIL_TURNS).map(renderTurn).filter(Boolean)
  const omitted = executions.length - KEEP_HEAD_TURNS - KEEP_TAIL_TURNS
  const placeholder = `\n--- [conversa longa: ${omitted} turno(s) do meio omitidos para caber no contexto. Foque nos primeiros turnos para entender o lead e nos últimos para julgar o desfecho.] ---\n`
  return [...head, placeholder, ...tail].join('\n')
}

function buildEvaluatorMessages(env, conversation) {
  const rulesText = getAgentRulesText(env)
  const ruleIds = AGENT_RULES_CATALOG.map((r) => r.id).join(', ')

  const system = `Você é um auditor de qualidade da IA de atendimento da Faculdade Sumaré.

Sua função é avaliar, de forma rigorosa e imparcial, se a IA respeitou TODAS as regras numeradas (${ruleIds}) abaixo durante uma conversa real com um lead via WhatsApp.

Para CADA regra de 1 a 22:
  - "ok": true se a IA respeitou; false se violou (mesmo que parcialmente) ou se demonstrou risco claro de violação.
  - "severity": "low" (recomendação), "medium" (problema notável) ou "high" (violação grave que pode regredir conversão).
  - "evidence": cite o turno e o trecho EXATO (resposta da IA) que comprova ok ou violação. Máx 240 chars.
  - "suggestion": texto curto opcional com como a IA deveria ter respondido (quando ok=false).

REGRAS NÃO APLICÁVEIS: se uma regra simplesmente não foi exercitada na conversa (ex.: lead não pediu grade → regra 14 não disparou), marque "ok": true com severity "low" e evidence "regra não exercitada nesta conversa". NÃO conte como violação.

VEREDITO:
  - APROVADO: zero regras com severity "high" e ≤ 1 com "medium".
  - PARCIAL: 1 ou 2 com "high" OU até 4 com "medium".
  - REPROVADO: 3+ com "high" OU regressão clara de funil (mentir, prometer o que não tem, recusar atendimento dentro do escopo).

SCORE: 0 a 10, decimal de 0.1. 10 = nenhum problema. 0 = conversa irrecuperável.

SUGESTÃO DE PATCH (somente quando houver violação alta/média recorrente):
  - "suggested_rule_id": id (1-22) da regra cuja redação parece insuficiente para evitar o erro. Pode ser null se a regra já é clara e o erro é da IA ignorando.
  - "suggested_new_body": reescrita SUGERIDA do corpo da regra inteira em português, mantendo o número e o título. Use o texto da regra original como base — só altere o que for necessário para fechar a brecha. Se rule_id for null, deixe null.
  - "suggestion_text": 1-3 parágrafos explicando por que essa mudança ajudaria.

Responda SEMPRE como JSON válido conforme o schema. Não escreva nada fora do JSON.`

  const user = `=== REGRAS DA IA (texto literal em produção) ===

${rulesText}

=== TRANSCRIÇÃO DA CONVERSA AVALIADA ===

${conversation || '(conversa vazia — marque verdict PARCIAL e score 5.0, explique nos campos suggestion)'}

=== TAREFA ===

Avalie a conversa acima contra cada uma das 22 regras e retorne o JSON estruturado.`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function getJsonSchema() {
  return {
    name: 'rule_evaluation',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'score', 'per_rule', 'suggestion_text', 'suggested_rule_id', 'suggested_new_body'],
      properties: {
        verdict: { type: 'string', enum: ['APROVADO', 'PARCIAL', 'REPROVADO'] },
        score: { type: 'number', minimum: 0, maximum: 10 },
        per_rule: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['rule_id', 'ok', 'severity', 'evidence', 'suggestion'],
            properties: {
              rule_id: { type: 'integer', minimum: 1, maximum: 22 },
              ok: { type: 'boolean' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              evidence: { type: 'string' },
              suggestion: { type: ['string', 'null'] },
            },
          },
        },
        suggestion_text: { type: ['string', 'null'] },
        suggested_rule_id: { type: ['integer', 'null'], minimum: 1, maximum: 22 },
        suggested_new_body: { type: ['string', 'null'] },
      },
    },
  }
}

async function callEvaluatorOpenAI(env, messages) {
  const key = getApiKey(env)
  if (!key) throw new Error('OPENAI_API_KEY ausente — defina no .env para usar Feedback IA')
  const model = resolveModel(env, 'rules_eval')

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: 'json_schema', json_schema: getJsonSchema() },
      }),
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`)
      err.httpStatus = res.status
      throw err
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`Resposta OpenAI não-JSON: ${text.slice(0, 200)}`)
    }
    const content = data?.choices?.[0]?.message?.content
    if (!content) throw new Error('Resposta OpenAI sem `choices[0].message.content`')
    const parsed = JSON.parse(content)
    return {
      parsed,
      model,
      usage: data?.usage || {},
      durationMs: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Classifica se vale tentar de novo. Erros permanentes (config errada,
 * 4xx exceto rate-limit/timeout) não dão retry — só gastariam tempo.
 */
function isTransientEvaluatorError(e) {
  if (!e) return false
  if (e.name === 'AbortError') return true
  const msg = String(e.message || '').toLowerCase()
  if (msg.includes('aborted') || msg.includes('timeout')) return true
  if (msg.includes('network') || msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('fetch failed')) return true
  const status = e.httpStatus
  if (Number.isFinite(status)) {
    if (status === 408 || status === 429) return true
    if (status >= 500 && status < 600) return true
    return false // outros 4xx (401/403/404/400) são definitivos
  }
  return false
}

/**
 * Tenta a chamada ao OpenAI até `MAX_EVAL_ATTEMPTS` em caso de falha
 * transitória. Erros permanentes (4xx de config) abortam imediatamente.
 * Retorna `{ parsed, model, usage, durationMs, attempts }`.
 */
async function callEvaluatorOpenAIWithRetry(env, messages) {
  const errors = []
  for (let attempt = 1; attempt <= MAX_EVAL_ATTEMPTS; attempt++) {
    try {
      const out = await callEvaluatorOpenAI(env, messages)
      if (attempt > 1) {
        console.log(`[feedbackIA] avaliador OK na tentativa ${attempt}/${MAX_EVAL_ATTEMPTS}`)
      }
      return { ...out, attempts: attempt }
    } catch (e) {
      errors.push(`tent${attempt}: ${String(e.message || e).slice(0, 160)}`)
      const transient = isTransientEvaluatorError(e)
      const last = attempt === MAX_EVAL_ATTEMPTS
      if (!transient || last) {
        const summary = errors.join(' | ')
        const finalErr = new Error(`Avaliador falhou após ${attempt} tentativa(s) [transient=${transient}] :: ${summary}`)
        finalErr.attempts = attempt
        finalErr.cause = e
        throw finalErr
      }
      const waitMs = RETRY_BASE_MS * Math.pow(2, attempt - 1)
      console.warn(`[feedbackIA] tentativa ${attempt}/${MAX_EVAL_ATTEMPTS} falhou (${String(e.message || e).slice(0, 100)}). Aguardando ${waitMs}ms antes de retentar…`)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  // unreachable
  throw new Error('Avaliador: loop de retry inconsistente')
}

/**
 * Avalia uma conversa (todas as execuções de um lead na janela). Insere
 * em `ai_rule_evaluations`. Retorna { ok, evaluation, skipped?, error? }.
 *
 * @param {Record<string,string>} env
 * @param {{ leadId?: number|string, telefone?: string, sinceIso?: string|null, untilIso?: string|null, trigger?: string }} opts
 */
export async function evaluateConversation(env, opts = {}) {
  const { leadId, telefone, sinceIso = null, untilIso = null, trigger = 'manual' } = opts
  if (leadId == null && !telefone) {
    return { ok: false, error: 'Informe leadId ou telefone' }
  }

  const executions = await listExecutionsForLead(env, { leadId, telefone, sinceIso, untilIso })
  if (executions.length === 0) {
    return { ok: false, skipped: 'no_executions', error: 'Nenhuma execução encontrada para esse lead na janela.' }
  }

  const lastMessageAt = executions[executions.length - 1]?.created_at || null
  const conversationKey = `${leadId ?? telefone}:${lastMessageAt || 'unknown'}`

  const transcript = buildConversationTranscript(executions)
  const messages = buildEvaluatorMessages(env, transcript)

  let result
  try {
    result = await callEvaluatorOpenAIWithRetry(env, messages)
  } catch (e) {
    // Erro técnico do avaliador (timeout, rede, OpenAI 5xx). NÃO É
    // reprovação do agente. Gravamos com verdict='PARCIAL' e `error`
    // preenchido — frontend detecta `error + tokens=0` e renderiza
    // como "Falha técnica" (cinza), não como reprovação vermelha.
    const row = {
      lead_id: leadId != null ? String(leadId) : null,
      telefone: telefone || null,
      conversation_key: conversationKey,
      last_message_at: lastMessageAt,
      turns_count: executions.length,
      verdict: 'PARCIAL',
      score: 0,
      per_rule: [],
      evaluator_model: resolveModel(env, 'rules_eval'),
      evaluator_total_tokens: 0,
      trigger,
      status: 'pending',
      error: String(e.message || e).slice(0, 1000),
    }
    const ins = await insertEvaluation(env, row)
    return { ok: false, error: e.message, inserted: ins.ok ? ins.data : null }
  }

  const usage = result.usage || {}
  const row = {
    lead_id: leadId != null ? String(leadId) : null,
    telefone: telefone || null,
    conversation_key: conversationKey,
    last_message_at: lastMessageAt,
    turns_count: executions.length,
    verdict: result.parsed.verdict,
    score: Math.max(0, Math.min(10, Number(result.parsed.score) || 0)),
    per_rule: Array.isArray(result.parsed.per_rule) ? result.parsed.per_rule : [],
    suggestion_text: result.parsed.suggestion_text || null,
    suggested_rule_id: result.parsed.suggested_rule_id ?? null,
    suggested_new_body: result.parsed.suggested_new_body || null,
    status: 'pending',
    evaluator_model: result.model,
    evaluator_prompt_tokens: usage.prompt_tokens ?? null,
    evaluator_completion_tokens: usage.completion_tokens ?? null,
    evaluator_total_tokens: usage.total_tokens ?? null,
    evaluator_duration_ms: result.durationMs ?? null,
    trigger,
  }

  const ins = await insertEvaluation(env, row)
  if (ins.ok) return { ok: true, evaluation: ins.data }
  if (ins.code === 'DUPLICATE') {
    return { ok: false, skipped: 'duplicate', error: 'Avaliação já existe para essa conversa.' }
  }
  return { ok: false, error: ins.error || `Falha ao gravar (${ins.code || ins.status})` }
}

/** Snapshot dos modelos resolvidos para o painel. */
export function getFeedbackIAModelInfo(env) {
  const snap = getModelRegistrySnapshot(env)
  return {
    rules_eval: snap.rules_eval,
    rules_patch: snap.rules_patch,
  }
}
