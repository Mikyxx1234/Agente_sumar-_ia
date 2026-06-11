/**
 * Backoff de retry quando o ENVIO do WhatsApp falha após gerar resposta.
 *
 * Sem isso, o ciclo flush → runAgent (LLM) → envio falha → repush → próximo
 * tick repete TUDO a cada ~10s, para sempre — foi o que aconteceu no incidente
 * do token Meta expirado (erro 190, 10-11/06/2026): 212 leads em loop, milhares
 * de execuções LLM queimadas sem nenhuma mensagem entregue.
 *
 * Regras:
 *  - A cada falha de envio consecutiva do MESMO conteúdo de buffer, o próximo
 *    retry espera mais: 1min, 2min, 4min… até o teto (30min).
 *  - Mensagem NOVA do cliente muda o hash do buffer → backoff não segura
 *    (o atendimento tenta de novo imediatamente, com o turno novo).
 *  - Envio confirmado limpa o estado.
 *
 * Estado em memória por processo: suficiente — um restart só custa 1 tentativa
 * extra; o objetivo é parar a queima contínua de LLM, não garantir exatidão.
 *
 * Env:
 *  AGENT_SEND_RETRY_BASE_SEC  (default 60)  espera após a 1ª falha
 *  AGENT_SEND_RETRY_MAX_SEC   (default 1800) teto do backoff
 */

import crypto from 'crypto'

/** sessionId → { hash, failCount, nextRetryAtMs } */
const state = new Map()

function hashItems(items) {
  const norm = (items || [])
    .map((x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean)
    .join('|')
  if (!norm) return ''
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 32)
}

function baseMs(env) {
  const v = Number(env?.AGENT_SEND_RETRY_BASE_SEC)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) * 1000 : 60_000
}

function maxMs(env) {
  const v = Number(env?.AGENT_SEND_RETRY_MAX_SEC)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) * 1000 : 1_800_000
}

/**
 * Registra falha de envio para o conteúdo atual do buffer (chamar junto do repush).
 * @returns {{ failCount: number, nextRetryInMs: number }}
 */
export function recordSendFailureBackoff(env, sessionId, items) {
  const sid = String(sessionId || '').trim()
  const h = hashItems(items)
  if (!sid || !h) return { failCount: 0, nextRetryInMs: 0 }
  const prev = state.get(sid)
  const failCount = prev && prev.hash === h ? prev.failCount + 1 : 1
  const delay = Math.min(baseMs(env) * 2 ** (failCount - 1), maxMs(env))
  state.set(sid, { hash: h, failCount, nextRetryAtMs: Date.now() + delay })
  return { failCount, nextRetryInMs: delay }
}

/**
 * Deve segurar o flush deste buffer? Só segura se o conteúdo é o MESMO que
 * falhou antes e ainda estamos dentro da janela de backoff.
 * @returns {{ hold: boolean, remainingMs?: number, failCount?: number }}
 */
export function shouldHoldForSendRetryBackoff(env, sessionId, items) {
  const sid = String(sessionId || '').trim()
  const entry = state.get(sid)
  if (!entry) return { hold: false }
  const h = hashItems(items)
  if (!h || h !== entry.hash) {
    // Conteúdo mudou (inbound novo) — não segurar; estado antigo já não vale.
    state.delete(sid)
    return { hold: false }
  }
  const remainingMs = entry.nextRetryAtMs - Date.now()
  if (remainingMs <= 0) return { hold: false, failCount: entry.failCount }
  return { hold: true, remainingMs, failCount: entry.failCount }
}

/** Envio confirmado — zera o backoff da sessão. */
export function clearSendRetryBackoff(sessionId) {
  state.delete(String(sessionId || '').trim())
}

/** Snapshot para diagnóstico/testes. */
export function getSendRetryBackoffSnapshot() {
  const out = []
  for (const [sid, e] of state) {
    out.push({
      sessionId: sid,
      failCount: e.failCount,
      retryInMs: Math.max(0, e.nextRetryAtMs - Date.now()),
    })
  }
  return out
}

/** Reset total (testes). */
export function resetSendRetryBackoffForTests() {
  state.clear()
}
