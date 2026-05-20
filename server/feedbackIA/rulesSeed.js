/**
 * Seed + parser das Regras 1-22 do override do agente.
 *
 * Fonte da verdade enquanto o DB estiver vazio: o texto hardcoded em
 * `server/ai/promptsLoader.js#getAgentRulesText`. A função abaixo
 * fragmenta esse texto em uma linha por regra usando regex em
 * multilinha. A regex captura desde "1. TÍTULO" até "2. TÍTULO" e
 * assim por diante.
 *
 * Quando o seed roda (no boot), checa se a tabela `agent_rules` tem 0
 * linhas. Se sim, faz upsert das 22 regras com source='seed'. Se
 * houver qualquer linha, NÃO faz nada — assim patches aplicados
 * sobrevivem a deploys.
 */

import { getAgentRulesText, AGENT_RULES_CATALOG } from '../ai/promptsLoader.js'
import { countAgentRules, insertSeedRules } from './rulesStore.js'

/**
 * Parseia o texto do override em uma lista de regras:
 * `[{id, title, body}, ...]` ordenada por id ascendente.
 *
 * Estratégia: cabeçalho do override é "## INSTRUÇÕES DO AGENTE
 * (PRIORIDADE MÁXIMA)" + parágrafo de explicação. Depois vêm blocos
 * iniciados por "<n>. <TÍTULO>" no começo da linha, onde n é 1..99
 * (limite generoso). Capturamos um bloco inteiro até a próxima
 * fronteira numerada ou fim do texto.
 */
export function parseHardcodedRules(env = process.env) {
  const text = getAgentRulesText(env)
  if (!text) return []

  // Remove o cabeçalho até a primeira fronteira de regra "^N. " (com N=1).
  // Tudo antes (introdução do override) NÃO entra como regra.
  const firstRuleIdx = text.search(/(^|\n)\s*1\.\s+/)
  const body = firstRuleIdx >= 0 ? text.slice(firstRuleIdx) : text

  // Regex: lookahead pelo próximo "(\n\d{1,2}\. )" ou fim de string.
  // Capturamos id, título, e corpo.
  const rules = []
  const re = /(?:^|\n)(\d{1,2})\.\s+([^\n]+)\n([\s\S]*?)(?=(?:\n\d{1,2}\.\s+)|$)/g
  let m
  while ((m = re.exec(body)) !== null) {
    const id = parseInt(m[1], 10)
    if (!Number.isFinite(id) || id < 1 || id > 99) continue
    const title = (m[2] || '').trim()
    const fullBody = `${id}. ${title}\n${m[3] || ''}`.trim()
    rules.push({ id, title, body: fullBody })
  }

  rules.sort((a, b) => a.id - b.id)
  return rules
}

/**
 * Garante que `agent_rules` tenha as 22 regras. Idempotente: se já há
 * qualquer linha, não faz nada. Roda no boot do servidor.
 *
 * Retorna { ok, action, count, error? }.
 *   action: 'seeded' | 'skipped' | 'table_missing' | 'error'
 */
export async function seedAgentRulesIfEmpty(env = process.env) {
  if (!env.SUPABASE_URL && !env.VITE_SUPABASE_URL) {
    return { ok: false, action: 'no_supabase', count: 0 }
  }

  const cnt = await countAgentRules(env)
  if (cnt.code === 'TABLE_MISSING') {
    return {
      ok: false,
      action: 'table_missing',
      count: 0,
      error: 'Rode scripts/sql/agent_rules.sql no Supabase antes de habilitar Fase 2.',
    }
  }
  if (!cnt.ok) {
    return { ok: false, action: 'error', count: 0, error: cnt.error }
  }
  if (cnt.count > 0) {
    return { ok: true, action: 'skipped', count: cnt.count }
  }

  const rules = parseHardcodedRules(env)
  if (rules.length === 0) {
    return { ok: false, action: 'parse_empty', count: 0, error: 'Parser retornou zero regras — verifique getAgentRulesText.' }
  }

  // Catálogo da Fase 1 (id + title em pt-BR resumido) tem precedência
  // sobre o título cru extraído do parser; assim a UI mostra título
  // amigável mesmo quando o body fica grande.
  const catalogTitleById = new Map(
    AGENT_RULES_CATALOG.map((r) => [r.id, r.title]),
  )
  const seeded = rules.map((r) => ({
    id: r.id,
    title: catalogTitleById.get(r.id) || r.title.slice(0, 120),
    body: r.body,
    version: 1,
  }))

  const ins = await insertSeedRules(env, seeded)
  if (!ins.ok) {
    return { ok: false, action: 'error', count: 0, error: ins.error }
  }
  return { ok: true, action: 'seeded', count: seeded.length }
}
