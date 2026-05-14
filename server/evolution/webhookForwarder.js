/**
 * Fan-out fire-and-forget: repassa o body do POST recebido em
 * /api/evolution/webhook para uma ou mais URLs configuradas em
 * EVOLUTION_WEBHOOK_FORWARD_URL (CSV separado por vírgula, espaço ou ;).
 *
 * Não bloqueia o caller — o envio acontece em background.
 * Mantém stats em memória por URL (igual ao padrão de webhookDiagnostics.js)
 * expostas via getForwarderSnapshot() para o endpoint /api/evolution/health.
 *
 * Caso de uso típico: UMA webhook na Evolution aponta pra este servidor;
 * este módulo replica o payload pro n8n (ou outro consumer) sem interferir
 * no processamento da IA.
 */

const LATENCY_WINDOW = 30

// Default: só repassa mensagens recebidas do lead. Eventos contacts.*,
// connection.update, presence.update, e mensagens fromMe=true (eco do
// que o bot mandou) são descartados — evita poluir o consumidor a
// jusante (n8n etc.) com tráfego que ele não usa.
const DEFAULT_FORWARD_EVENTS = ['messages.upsert']

/** @type {Map<string, import('./webhookForwarderTypes').ForwarderStats>} */
const statsMap = new Map()

// Contadores globais de payloads não repassados (evento fora da
// allowlist ou fromMe=true). Servem pra mostrar no painel quantas
// "ativações" foram silenciosamente puladas.
let skippedByEvent = 0
let skippedByFromMe = 0

function getOrCreateStats(url) {
  if (!statsMap.has(url)) {
    statsMap.set(url, {
      url,
      attemptCount: 0,
      successCount: 0,
      failureCount: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastStatus: null,
      latencyMsRecent: [],
    })
  }
  return statsMap.get(url)
}

/**
 * Lê EVOLUTION_WEBHOOK_FORWARD_URL do env, separa por vírgula/espaço/;
 * e filtra apenas URLs válidas (http:// ou https://).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function parseForwardUrls(env) {
  const raw = env.EVOLUTION_WEBHOOK_FORWARD_URL || ''
  if (!raw.trim()) return []
  return raw
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('http://') || s.startsWith('https://'))
}

/**
 * Lista de eventos do Evolution que devem ser repassados.
 * Default: apenas messages.upsert. Pode ser sobreescrita com
 * EVOLUTION_WEBHOOK_FORWARD_EVENTS=event1,event2 (vazio = default).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function parseForwardEvents(env) {
  const raw = String(env.EVOLUTION_WEBHOOK_FORWARD_EVENTS || '').trim()
  if (!raw) return DEFAULT_FORWARD_EVENTS
  const list = raw.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean)
  return list.length > 0 ? list : DEFAULT_FORWARD_EVENTS
}

function includeFromMe(env) {
  const raw = String(env.EVOLUTION_WEBHOOK_FORWARD_INCLUDE_FROM_ME || '').toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes'
}

/**
 * Mascara a URL para exibição: mantém scheme://host/path mas remove
 * query string e trunca paths longos (> 40 chars → "...últimos 40 chars").
 *
 * @param {string} url
 * @returns {string}
 */
function maskUrl(url) {
  try {
    const u = new URL(url)
    let path = u.pathname
    if (path.length > 40) {
      path = '...' + path.slice(-40)
    }
    return `${u.protocol}//${u.host}${path}`
  } catch {
    return url.slice(0, 60)
  }
}

function calcP95(arr) {
  if (arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)]
}

function calcAvg(arr) {
  if (arr.length === 0) return null
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
}

function calcMax(arr) {
  if (arr.length === 0) return null
  return Math.max(...arr)
}

function urlStatus(s) {
  if (s.attemptCount === 0) return 'idle'
  const failureRate = s.failureCount / s.attemptCount
  const lastWasFail = s.lastFailureAt && (s.lastSuccessAt == null || s.lastFailureAt > s.lastSuccessAt)
  if (lastWasFail || failureRate > 0.2) return 'fail'
  if (failureRate > 0.05) return 'warn'
  return 'ok'
}

/**
 * Dispara o POST para todas as URLs configuradas sem bloquear o caller.
 * Erros (rede, timeout, status não-2xx) são registrados nas stats
 * mas não propagados.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {unknown} body Objeto já parseado pelo Express (req.body)
 */
export function forwardEvolutionWebhook(env, body) {
  const urls = parseForwardUrls(env)
  if (urls.length === 0) return

  // Filtros aplicados antes do envio. Por padrão só repassa
  // messages.upsert (mensagens reais do lead), descartando
  // contacts.*, connection.update, presence.update e ecos
  // do bot (fromMe=true).
  const evt = body?.event != null ? String(body.event) : ''
  const allowedEvents = parseForwardEvents(env)
  if (evt && !allowedEvents.includes(evt)) {
    skippedByEvent += 1
    return
  }

  if (!includeFromMe(env)) {
    const data = body?.data || {}
    const fromMe = data?.key?.fromMe
    if (fromMe === true) {
      skippedByFromMe += 1
      return
    }
  }

  const timeoutMs = Number(env.EVOLUTION_WEBHOOK_FORWARD_TIMEOUT_MS) || 8000
  const bodyStr = JSON.stringify(body)

  setImmediate(() => {
    for (const url of urls) {
      const stats = getOrCreateStats(url)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const startedAt = Date.now()

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'agente-comercial-fanout/1.0',
        },
        body: bodyStr,
        signal: controller.signal,
      })
        .then((resp) => {
          clearTimeout(timer)
          const latency = Date.now() - startedAt
          const now = Date.now()

          stats.attemptCount += 1
          stats.lastAttemptAt = now
          stats.lastStatus = resp.status

          if (stats.latencyMsRecent.length >= LATENCY_WINDOW) {
            stats.latencyMsRecent.shift()
          }
          stats.latencyMsRecent.push(latency)

          if (resp.ok) {
            stats.successCount += 1
            stats.lastSuccessAt = now
            console.log(`[Evolution][fanout] ${url} OK ${resp.status} em ${latency}ms`)
          } else {
            stats.failureCount += 1
            stats.lastFailureAt = now
            stats.lastError = `HTTP ${resp.status}`
            console.log(`[Evolution][fanout][ERR] ${url} ${resp.status} em ${latency}ms`)
          }
        })
        .catch((err) => {
          clearTimeout(timer)
          const latency = Date.now() - startedAt
          const now = Date.now()

          stats.attemptCount += 1
          stats.lastAttemptAt = now
          stats.failureCount += 1
          stats.lastFailureAt = now
          stats.lastError = String(err?.message || err).slice(0, 400)

          if (stats.latencyMsRecent.length >= LATENCY_WINDOW) {
            stats.latencyMsRecent.shift()
          }
          stats.latencyMsRecent.push(latency)

          console.log(`[Evolution][fanout][ERR] ${url} erro em ${latency}ms: ${stats.lastError}`)
        })
    }
  })
}

/**
 * Snapshot das estatísticas de fan-out para o endpoint de health.
 *
 * `enabled` e `configuredCount` derivam de EVOLUTION_WEBHOOK_FORWARD_URL,
 * não do mapa de stats — assim o painel sabe que está ligado mesmo antes
 * do primeiro POST chegar (status da URL aparece como "idle").
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ enabled: boolean, configuredCount: number, urls: object[], totalAttempts: number, totalSuccess: number, totalFailure: number, skippedByEvent: number, skippedByFromMe: number }}
 */
export function getForwarderSnapshot(env = process.env) {
  const now = Date.now()
  const configuredUrls = parseForwardUrls(env)

  // Garante que toda URL configurada tem entrada no map mesmo antes de
  // receber tráfego — sem isso a tabela do painel ficaria vazia até o
  // primeiro POST.
  for (const url of configuredUrls) {
    getOrCreateStats(url)
  }

  const urlEntries = [...statsMap.values()]

  const totalAttempts = urlEntries.reduce((s, u) => s + u.attemptCount, 0)
  const totalSuccess = urlEntries.reduce((s, u) => s + u.successCount, 0)
  const totalFailure = urlEntries.reduce((s, u) => s + u.failureCount, 0)

  const urls = urlEntries.map((s) => {
    const failureRate = s.attemptCount > 0 ? s.failureCount / s.attemptCount : 0
    return {
      url: s.url,
      urlMasked: maskUrl(s.url),
      attemptCount: s.attemptCount,
      successCount: s.successCount,
      failureCount: s.failureCount,
      lastAttemptAt: s.lastAttemptAt,
      lastSuccessAt: s.lastSuccessAt,
      lastFailureAt: s.lastFailureAt,
      lastAttemptAgeSec: s.lastAttemptAt != null ? Math.round((now - s.lastAttemptAt) / 1000) : null,
      lastSuccessAgeSec: s.lastSuccessAt != null ? Math.round((now - s.lastSuccessAt) / 1000) : null,
      lastFailureAgeSec: s.lastFailureAt != null ? Math.round((now - s.lastFailureAt) / 1000) : null,
      lastError: s.lastError,
      lastStatus: s.lastStatus,
      latencyAvgMs: calcAvg(s.latencyMsRecent),
      latencyMaxMs: calcMax(s.latencyMsRecent),
      latencyP95Ms: calcP95(s.latencyMsRecent),
      failureRate,
      status: urlStatus(s),
    }
  })

  return {
    enabled: configuredUrls.length > 0,
    configuredCount: configuredUrls.length,
    urls,
    totalAttempts,
    totalSuccess,
    totalFailure,
    skippedByEvent,
    skippedByFromMe,
  }
}
