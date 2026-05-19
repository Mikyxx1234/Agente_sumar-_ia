/**
 * Classifica se a mensagem do lead está no escopo do atendimento
 * comercial da Faculdade Sumaré.
 */

import { resolveModel } from './modelRegistry.js'
import { loadClassifierSystemPrompt } from './promptsLoader.js'
import {
  DEFAULT_SCOPE_REFUSAL,
  matchScopeHeuristic,
  normalizeMessageForScope,
  messageLooksEducational,
  messageLooksCareerIncomeOpportunity,
  isGreetingOnly,
} from '../../libShared/scopeHeuristics.js'

const URL_CHAT = 'https://api.openai.com/v1/chat/completions'
const TIMEOUT_MS = 5000

const CLASSIFIER_HARD_RULES = `

REGRA ABSOLUTA (prioridade sobre qualquer outro texto):
- Perguntas de cultura geral, geografia (capitais, países), política internacional, economia global, SQL, programação, APIs, planilhas, notícias e tecnologia SEM relação com cursos ou matrícula da Faculdade Sumaré → dentro_escopo: false, categoria: fora_escopo.
- Exemplos SEMPRE fora do escopo: "qual a capital da China", "como está a relação EUA-China", "query SQL", "como criar tabela vetorizada".
- DENTRO DO ESCOPO (categoria: oportunidade_comercial): lead quer ganhar dinheiro, mudar de vida, carreira, emprego, futuro profissional, trabalhar no digital/mundo digital/internet — mesmo sem citar "curso". O orquestrador vai sugerir formação e cursos da Sumaré.
- DENTRO DO ESCOPO (categoria: saudacao): cumprimentos simples sem outro assunto — "oi", "olá", "bom dia", "boa tarde", "boa noite", "tudo bem?". NUNCA classifique como fora_escopo.
- Exemplos SEMPRE dentro do escopo: "quero ganhar dinheiro no mundo digital", "como melhorar minha carreira", "qual curso me dá mais emprego", "bom dia", "oi".
- Também é dentro_escopo se o lead pergunta sobre cursos, preços, matrícula, inscrição, modalidade EAD, grade ou atendimento educacional da Faculdade Sumaré.`

function isEnabled(env) {
  return String(env.SCOPE_CLASSIFIER_ENABLED ?? 'true').toLowerCase() !== 'false'
}

function refusalMessage(env) {
  const custom = String(env.SCOPE_CLASSIFIER_REFUSAL_MESSAGE || '').trim()
  return custom || DEFAULT_SCOPE_REFUSAL
}

function formatHistoryForClassifier(historyMessages) {
  if (!Array.isArray(historyMessages) || historyMessages.length === 0) return ''
  return historyMessages
    .slice(-4)
    .map((m) => {
      const role = m.role === 'assistant' ? 'assistente' : 'lead'
      return `- ${role}: ${String(m.content || '').slice(0, 300)}`
    })
    .join('\n')
}

function parseClassification(raw) {
  try {
    const parsed = JSON.parse(raw)
    const dentro = parsed.dentro_escopo
    if (typeof dentro === 'boolean') {
      // ok
    } else if (dentro === 'true' || dentro === true) parsed.dentro_escopo = true
    else if (dentro === 'false' || dentro === false) parsed.dentro_escopo = false
    else return null
    return {
      dentro_escopo: Boolean(parsed.dentro_escopo),
      categoria: String(parsed.categoria || 'indefinido').slice(0, 40),
      nivel: String(parsed.nivel || 'indefinido').slice(0, 24),
      motivo: String(parsed.motivo || '').slice(0, 200),
    }
  } catch {
    return null
  }
}

function blockResult(env, classification, source, reason, model, usage, elapsedMs) {
  return {
    blocked: true,
    reply: refusalMessage(env),
    classification,
    source,
    reason,
    model,
    usage: usage || null,
    elapsedMs,
  }
}

export { normalizeMessageForScope, matchScopeHeuristic }

/**
 * @param {Record<string,string>} env
 * @param {{ userMessage: string, historyMessages?: Array<{role:string,content:string}> }} input
 */
export async function classifyMessageScope(env, input = {}) {
  const userMessage = normalizeMessageForScope(input.userMessage)
  const model = resolveModel(env, 'scope_classifier')
  const t0 = Date.now()

  if (!isEnabled(env)) {
    return { blocked: false, reply: null, classification: null, source: 'skipped', reason: 'disabled', model, usage: null, elapsedMs: Date.now() - t0 }
  }
  if (!userMessage) {
    return { blocked: false, reply: null, classification: null, source: 'skipped', reason: 'empty', model, usage: null, elapsedMs: Date.now() - t0 }
  }

  if (isGreetingOnly(userMessage)) {
    return {
      blocked: false,
      reply: null,
      classification: {
        dentro_escopo: true,
        categoria: 'saudacao',
        nivel: 'indefinido',
        motivo: 'saudação simples',
      },
      source: 'heuristic',
      reason: 'greeting',
      model,
      usage: null,
      elapsedMs: Date.now() - t0,
    }
  }

  const heuristic = matchScopeHeuristic(userMessage)
  if (heuristic) {
    return blockResult(env, heuristic, 'heuristic', 'heuristic_match', model, null, Date.now() - t0)
  }

  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) {
    if (!messageLooksEducational(userMessage)) {
      return blockResult(
        env,
        { dentro_escopo: false, categoria: 'fora_escopo', nivel: 'indefinido', motivo: 'sem API key e sem tema educacional detectado' },
        'heuristic',
        'no_api_key_strict',
        model,
        null,
        Date.now() - t0,
      )
    }
    return { blocked: false, reply: null, classification: null, source: 'skipped', reason: 'no_api_key', model, usage: null, elapsedMs: Date.now() - t0 }
  }

  const systemPrompt = (await loadClassifierSystemPrompt()) + CLASSIFIER_HARD_RULES
  const historyBlock = formatHistoryForClassifier(input.historyMessages)
  const userPrompt = historyBlock
    ? `Histórico recente da conversa:\n${historyBlock}\n\nMensagem atual do lead:\n"${userMessage}"`
    : `Mensagem do lead:\n"${userMessage}"`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(URL_CHAT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 120,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    })
    const elapsedMs = Date.now() - t0

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[scopeClassifier] http ${res.status}: ${body.slice(0, 160)}`)
      const fallback = matchScopeHeuristic(userMessage)
      if (fallback) return blockResult(env, fallback, 'heuristic', `http_${res.status}_fallback`, model, null, elapsedMs)
      return { blocked: false, reply: null, classification: null, source: 'skipped', reason: `http_${res.status}`, model, usage: null, elapsedMs }
    }

    const data = await res.json()
    const usage = data?.usage || null
    const classification = parseClassification(data?.choices?.[0]?.message?.content || '')

    if (!classification) {
      const fallback = matchScopeHeuristic(userMessage)
      if (fallback) return blockResult(env, fallback, 'heuristic', 'invalid_json_fallback', model, usage, elapsedMs)
      return { blocked: false, reply: null, classification: null, source: 'skipped', reason: 'invalid_json', model, usage, elapsedMs }
    }

    if (classification.dentro_escopo === false) {
      if (messageLooksCareerIncomeOpportunity(userMessage)) {
        return {
          blocked: false,
          reply: null,
          classification: {
            ...classification,
            dentro_escopo: true,
            categoria: 'oportunidade_comercial',
            motivo: 'redirecionamento comercial (carreira/dinheiro/digital)',
          },
          source: 'llm',
          reason: 'commercial_redirect_override',
          model,
          usage,
          elapsedMs,
        }
      }
      return blockResult(env, classification, 'llm', 'out_of_scope', model, usage, elapsedMs)
    }

    // Segunda linha de defesa: LLM disse "dentro" mas heurística geral detecta tema aleatório
    const postCheck = matchScopeHeuristic(userMessage)
    if (postCheck) {
      return blockResult(env, { ...postCheck, motivo: 'pós-LLM: ' + postCheck.motivo }, 'heuristic', 'post_llm_override', model, usage, elapsedMs)
    }

    return { blocked: false, reply: null, classification, source: 'llm', reason: 'in_scope', model, usage, elapsedMs }
  } catch (e) {
    const elapsedMs = Date.now() - t0
    const aborted = e?.name === 'AbortError'
    console.warn(`[scopeClassifier] ${aborted ? 'timeout' : e.message}`)
    const fallback = matchScopeHeuristic(userMessage)
    if (fallback) return blockResult(env, fallback, 'heuristic', aborted ? 'timeout_fallback' : 'error_fallback', model, null, elapsedMs)
    return { blocked: false, reply: null, classification: null, source: 'skipped', reason: aborted ? 'timeout' : `error:${e?.message?.slice(0, 60)}`, model, usage: null, elapsedMs }
  } finally {
    clearTimeout(timer)
  }
}
