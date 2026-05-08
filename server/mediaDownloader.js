/**
 * Download genérico de mídia por URL → base64.
 *
 * Usado quando a fonte da mensagem (banco-kommo-dispatcher, Amojo, etc.)
 * devolve só `media_url` em vez do conteúdo. A URL pode vir de várias
 * origens, então a gente tenta várias estratégias de auth:
 *
 *   1) Fetch direto (CDN público — Kommo/Amojo costumam ser).
 *   2) Bearer WHATSAPP_ACCESS_TOKEN se a URL é da Meta
 *      (graph.facebook.com / lookaside.fbsbx.com / mmg.whatsapp.net).
 *   3) Bearer KOMMO_ACCESS_TOKEN se a URL é do Kommo
 *      (.kommo.com / amojo.kommo.com).
 *
 * Faz fallback automático e devolve detalhes do erro pra debug.
 */

const META_HOSTS = [
  'graph.facebook.com',
  'lookaside.fbsbx.com',
  'mmg.whatsapp.net',
  'cdn.whatsapp.net',
  'media.whatsapp.net',
]
const KOMMO_HOSTS = ['.kommo.com', 'amojo.kommo.com']

function urlMatchesHost(url, hosts) {
  try {
    const u = new URL(url)
    return hosts.some((h) => u.hostname === h || u.hostname.endsWith(h))
  } catch {
    return false
  }
}

async function attempt(url, headers = {}, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const startMs = Date.now()
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    const elapsedMs = Date.now() - startMs
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        status: res.status,
        error: text.slice(0, 300),
        elapsedMs,
      }
    }
    const ab = await res.arrayBuffer()
    const mimeType = res.headers.get('content-type') || null
    return {
      ok: true,
      status: res.status,
      base64: Buffer.from(ab).toString('base64'),
      bytes: ab.byteLength,
      mimeType,
      elapsedMs,
    }
  } catch (e) {
    const elapsedMs = Date.now() - startMs
    const aborted = e?.name === 'AbortError'
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'FETCH_FAILED',
      error: aborted ? `timeout após ${elapsedMs}ms` : e.message,
      elapsedMs,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Baixa o conteúdo de uma URL e devolve como base64.
 *
 * @param {Record<string,string>} env
 * @param {string} url
 * @returns {Promise<{ok: true, base64: string, mimeType: string|null, bytes: number, attempts: string[], elapsedMs: number}
 *   | {ok: false, code?: string, status?: number, error: string, attempts: string[], elapsedMs: number}>}
 */
export async function downloadUrlAsBase64(env, url) {
  if (!url || typeof url !== 'string') {
    return { ok: false, code: 'INVALID_URL', error: 'url ausente', attempts: [], elapsedMs: 0 }
  }
  const tries = []
  let elapsed = 0

  // Estratégia 1: fetch direto.
  const r1 = await attempt(url)
  elapsed += r1.elapsedMs || 0
  tries.push(`direct=${r1.ok ? 'ok' : `${r1.status || r1.code || 'fail'}`}`)
  if (r1.ok) return { ...r1, attempts: tries, elapsedMs: elapsed }

  // Estratégia 2: WhatsApp Cloud API.
  if (env.WHATSAPP_ACCESS_TOKEN && urlMatchesHost(url, META_HOSTS)) {
    const r2 = await attempt(url, { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` })
    elapsed += r2.elapsedMs || 0
    tries.push(`waba=${r2.ok ? 'ok' : `${r2.status || r2.code || 'fail'}`}`)
    if (r2.ok) return { ...r2, attempts: tries, elapsedMs: elapsed }
  }

  // Estratégia 3: Kommo (Bearer).
  if (env.KOMMO_ACCESS_TOKEN && urlMatchesHost(url, KOMMO_HOSTS)) {
    const r3 = await attempt(url, { Authorization: `Bearer ${env.KOMMO_ACCESS_TOKEN}` })
    elapsed += r3.elapsedMs || 0
    tries.push(`kommo=${r3.ok ? 'ok' : `${r3.status || r3.code || 'fail'}`}`)
    if (r3.ok) return { ...r3, attempts: tries, elapsedMs: elapsed }
  }

  return {
    ok: false,
    status: r1.status || null,
    code: r1.code || 'ALL_ATTEMPTS_FAILED',
    error: r1.error || 'falha em todas as estratégias',
    attempts: tries,
    elapsedMs: elapsed,
  }
}
