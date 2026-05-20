/**
 * Gerador de patch de regra — usa `gpt-5` (papel `rules_patch`) para
 * consolidar várias evidências de violação da mesma regra em uma
 * proposta de novo corpo. Não aplica nada — só sugere.
 *
 * Entrada:
 *   - rule atual (texto completo do body)
 *   - amostras: [{ evidence, severity, suggestion?, leadId }]
 *   - regras vizinhas (id, title) para contexto de numeração
 *
 * Saída:
 *   { new_body: string, justification: string, risk_notes: string|null,
 *     keep_compatible: boolean }
 */

import { resolveModel } from '../ai/modelRegistry.js'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_TIMEOUT_MS = 90_000

function getApiKey(env) {
  return env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY || ''
}

function buildMessages({ rule, samples, catalog }) {
  const catalogStr = catalog
    .map((c) => `  #${c.id} — ${c.title}${c.id === rule.id ? '  ← regra que você vai reescrever' : ''}`)
    .join('\n')

  const samplesStr = (samples || [])
    .map((s, i) => `Amostra ${i + 1} (lead=${s.leadId || '?'}, severity=${s.severity || 'low'}):
  EVIDÊNCIA: ${s.evidence || '(sem evidência)'}
  SUGESTÃO DO AVALIADOR: ${s.suggestion || '(nenhuma)'}`)
    .join('\n\n')

  const system = `Você é um arquiteto sênior do prompt do agente de atendimento da Faculdade Sumaré.

Sua tarefa: reescrever UMA regra do override do agente para fechar lacunas que vêm sendo exploradas em produção. Você deve receber:
  - A regra atual (texto literal que está rodando).
  - Amostras de evidências reais onde a IA violou essa regra.
  - O catálogo de TODAS as regras (1-22) para você não criar conflito com outras.

Princípios obrigatórios:
  1. MANTENHA o número da regra ("N. ") no início. NUNCA mude o id.
  2. MANTENHA o título original (linha 1) ou ajuste com leveza se a redação melhorar (sem inventar tema novo).
  3. PRESERVE comportamento das outras regras. Se sua mudança conflita com a regra X, ajuste sua redação para deixar claro qual prevalece — ou recomende explicitamente em risk_notes.
  4. SEJA CIRÚRGICO. Mude o mínimo necessário para fechar as evidências. NÃO reescreva tudo só para "ficar bonito".
  5. NÃO invente tools, marcadores [...] ou conceitos que não existem hoje.
  6. PROIBIDO remover salvaguardas (regras com "PROIBIDO", "NUNCA", "OBRIGATÓRIO" devem permanecer).
  7. Tom: técnico, imperativo, alinhado às outras regras. Em pt-BR. Pode usar listas a/b/c/d, sub-itens.
  8. Comprimento: nem mais curto que a regra atual (perde nuance), nem mais que 2× o tamanho dela.

Devolva JSON estrito conforme o schema. NÃO escreva nada fora do JSON.`

  const user = `=== REGRA ATUAL #${rule.id} ===

${rule.body}

=== CATÁLOGO DE REGRAS (contexto, não reescreva as outras) ===

${catalogStr}

=== EVIDÊNCIAS DE VIOLAÇÃO COLETADAS ===

${samplesStr || '(nenhuma evidência fornecida — proponha apenas pequenos refinamentos defensivos)'}

=== TAREFA ===

Reescreva apenas a regra #${rule.id} fechando as lacunas acima.`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function getJsonSchema() {
  return {
    name: 'rule_patch',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['new_body', 'justification', 'risk_notes', 'keep_compatible'],
      properties: {
        new_body: { type: 'string' },
        justification: { type: 'string' },
        risk_notes: { type: ['string', 'null'] },
        keep_compatible: { type: 'boolean' },
      },
    },
  }
}

/**
 * @param {Record<string,string>} env
 * @param {{ rule: { id:number, body:string, title:string }, samples: Array, catalog: Array<{id:number,title:string}> }} input
 */
export async function generateRulePatch(env, input) {
  const key = getApiKey(env)
  if (!key) {
    return { ok: false, error: 'OPENAI_API_KEY ausente' }
  }
  const model = resolveModel(env, 'rules_patch')
  const messages = buildMessages(input)

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
      return { ok: false, error: `OpenAI ${res.status}: ${text.slice(0, 400)}` }
    }
    const data = JSON.parse(text)
    const content = data?.choices?.[0]?.message?.content
    if (!content) return { ok: false, error: 'Resposta OpenAI sem content' }
    const parsed = JSON.parse(content)
    const newBody = String(parsed.new_body || '').trim()

    // Salvaguarda: precisa começar com "N. ", senão prefixamos.
    const prefix = `${input.rule.id}. `
    const fixedBody = newBody.startsWith(prefix) ? newBody : `${prefix}${newBody}`

    return {
      ok: true,
      data: {
        new_body: fixedBody,
        justification: parsed.justification || '',
        risk_notes: parsed.risk_notes || null,
        keep_compatible: Boolean(parsed.keep_compatible),
      },
      model,
      usage: data?.usage || {},
      durationMs: Date.now() - startedAt,
    }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    clearTimeout(t)
  }
}
