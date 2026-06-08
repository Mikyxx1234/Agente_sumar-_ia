/**
 * Rate limiter GLOBAL para a API do Kommo.
 *
 * A conta foi bloqueada pelo Kommo por exceder o teto de 7 requisições/segundo.
 * Este módulo é o único ponto que garante que NUNCA passamos desse limite:
 *
 *   - Serializa TODA chamada ao Kommo numa fila única (process-wide).
 *   - Espaça o início de cada requisição por no mínimo `1000 / KOMMO_MAX_RPS` ms.
 *   - `KOMMO_MAX_RPS` tem default 5 e um HARD CAP de 6 — mesmo que alguém
 *     configure um valor alto, jamais chega aos 7/s do Kommo.
 *   - Em 429/403 (rate limit / bloqueio), pausa a fila inteira respeitando o
 *     header `Retry-After` (ou um backoff padrão) em vez de continuar martelando.
 *
 * Use sempre `kommoRawFetch(url, init)` no lugar de `fetch(url, init)` para
 * qualquer chamada ao host do Kommo (api/v4 e amojo). O `kommoFetch` central
 * (server/kommoClient.js) já passa por aqui.
 */

const DEFAULT_RPS = 5
// Teto rígido: o limite do Kommo é 7/s. Nunca permitimos chegar lá.
const HARD_CAP_RPS = 6
const DEFAULT_TIMEOUT_MS = 20_000
// Backoff padrão quando não há Retry-After.
const DEFAULT_BACKOFF_429_MS = 10_000
const DEFAULT_BACKOFF_403_MS = 60_000

let tail = Promise.resolve()
let lastStartMs = 0
let pausedUntilMs = 0
let pendingCount = 0
let totalDispatched = 0
let totalPaused = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

function resolveRps() {
  let rps = Number(process.env.KOMMO_MAX_RPS)
  if (!Number.isFinite(rps) || rps <= 0) rps = DEFAULT_RPS
  return Math.min(HARD_CAP_RPS, Math.max(1, rps))
}

function resolveMinIntervalMs() {
  return 1000 / resolveRps()
}

function resolveTimeoutMs() {
  const v = Number(process.env.KOMMO_API_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_TIMEOUT_MS
}

/**
 * Pausa a fila inteira por `ms` (usado no backoff de 429/403).
 * @param {number} ms
 */
export function pauseKommoRequests(ms) {
  const until = Date.now() + Math.max(0, Number(ms) || 0)
  if (until > pausedUntilMs) {
    pausedUntilMs = until
    totalPaused += 1
  }
}

function parseRetryAfterMs(headers) {
  try {
    const raw = headers?.get?.('retry-after')
    if (!raw) return null
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000
    const when = Date.parse(raw)
    if (Number.isFinite(when)) return Math.max(0, when - Date.now())
  } catch {
    /* ignore */
  }
  return null
}

function backoffMsForStatus(status, headers) {
  const retryAfter = parseRetryAfterMs(headers)
  if (retryAfter != null) return retryAfter
  return status === 403 ? DEFAULT_BACKOFF_403_MS : DEFAULT_BACKOFF_429_MS
}

/**
 * Executa `fn` respeitando o rate limit global. Toda chamada é serializada e
 * espaçada para não exceder `KOMMO_MAX_RPS` (≤ HARD_CAP_RPS, sempre < 7).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runWithKommoRateLimit(fn) {
  pendingCount += 1
  const run = tail.then(async () => {
    const minInterval = resolveMinIntervalMs()
    // 1) Respeita pausa global (backoff de 429/403).
    let now = Date.now()
    if (pausedUntilMs > now) {
      await sleep(pausedUntilMs - now)
      now = Date.now()
    }
    // 2) Garante o espaçamento mínimo entre inícios de requisição.
    const wait = lastStartMs + minInterval - now
    if (wait > 0) {
      await sleep(wait)
      now = Date.now()
    }
    lastStartMs = now
    totalDispatched += 1
    return fn()
  })
  // A cadeia continua independente de sucesso/erro de `fn` (não propaga rejeição).
  tail = run.then(
    () => {},
    () => {},
  ).finally(() => {
    pendingCount -= 1
  })
  return run
}

/**
 * Substituto de `fetch` para o host do Kommo. Passa pelo rate limiter, adiciona
 * timeout e dispara o backoff global em 429/403. Retorna a `Response` nativa —
 * o caller continua lendo `.ok`/`.status`/`.json()`/`.text()` como antes.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function kommoRawFetch(url, init = {}) {
  return runWithKommoRateLimit(async () => {
    let signal = init.signal
    if (!signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(resolveTimeoutMs())
    }
    const res = await fetch(url, { ...init, signal })
    if (res && (res.status === 429 || res.status === 403)) {
      pauseKommoRequests(backoffMsForStatus(res.status, res.headers))
    }
    return res
  })
}

/** Snapshot para diagnóstico (/api/agent/diagnose etc.). */
export function getKommoRateLimiterSnapshot() {
  const now = Date.now()
  return {
    maxRps: resolveRps(),
    hardCapRps: HARD_CAP_RPS,
    minIntervalMs: Math.round(resolveMinIntervalMs()),
    timeoutMs: resolveTimeoutMs(),
    pending: pendingCount,
    pausedMsRemaining: pausedUntilMs > now ? pausedUntilMs - now : 0,
    totalDispatched,
    totalPaused,
  }
}
