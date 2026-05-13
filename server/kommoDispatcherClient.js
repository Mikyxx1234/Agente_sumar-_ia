/**
 * Cliente para o serviço `banco-kommo-dispatcher` (FastAPI) que roda em rede
 * interna do EasyPanel. O dispatcher mantém um cache atualizado das mensagens
 * dos chats Kommo (Amojo + Playwright) e expõe uma API REST limpa.
 *
 * Endpoints usados:
 *   GET  /api/kommo/messages/by-lead/{lead_id}?limit=N&order=desc|asc
 *   POST /api/kommo/messages/sync/{lead_id}    (opcional, força sync agora)
 *
 * Schema de mensagem (one row):
 *   {
 *     id: number,                 // PK numérico crescente — usado como cursor
 *     lead_id: number,
 *     contact_id: number,
 *     talk_id: string,
 *     chat_id: string,
 *     sender_name: string,
 *     sender_phone: string,
 *     sender_type: 'contact'|'user'|'bot',  // contact = inbound (cliente)
 *     message_text: string,
 *     message_type: 'text'|'voice'|'picture'|...,
 *     media_url: string|null,
 *     sent_at: 'YYYY-MM-DDTHH:mm:ss',
 *     origin: 'waba'|'amocrm'|...,
 *     synced_at: 'YYYY-MM-DDTHH:mm:ss.ssssss'
 *   }
 *
 * Env:
 *   KOMMO_DISPATCHER_URL  default http://banco-kommo-dispatcher:8000
 */

function getDispatcherUrl(env) {
  return String(
    env.KOMMO_DISPATCHER_URL || 'http://banco-kommo-dispatcher:8000',
  ).replace(/\/$/, '')
}

// Loga 1× a URL efetiva (e se veio de env ou default) na 1ª chamada.
// Útil pra diagnosticar ENOTFOUND em produção sem precisar inspecionar
// container: o log mostra exatamente qual host o agente está tentando
// resolver.
let loggedUpstream = null
function logUpstreamOnce(env, upstream) {
  if (loggedUpstream === upstream) return
  loggedUpstream = upstream
  const source = env.KOMMO_DISPATCHER_URL ? 'env KOMMO_DISPATCHER_URL' : 'default (sem env definida)'
  console.log(`[kommoDispatcherClient] upstream=${upstream} (origem: ${source})`)
}

async function dispatcherFetch(env, path, { method = 'GET', timeoutMs = 12000 } = {}) {
  const upstream = getDispatcherUrl(env)
  logUpstreamOnce(env, upstream)
  const url = `${upstream}${path}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const startMs = Date.now()
  try {
    const r = await fetch(url, { method, signal: ctrl.signal })
    const elapsedMs = Date.now() - startMs
    const raw = await r.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = raw
    }
    return { ok: r.ok, status: r.status, data, raw, url, elapsedMs }
  } catch (e) {
    const cause = e?.cause?.code || e?.code || null
    let hint = null
    if (cause === 'ENOTFOUND') {
      hint = `DNS falhou para ${upstream}. Verifique no Easypanel: (a) se o serviço banco-kommo-dispatcher está rodando, (b) se está na mesma rede do container do agente, (c) se o nome bate. Se o nome for outro, defina KOMMO_DISPATCHER_URL.`
    } else if (cause === 'ECONNREFUSED') {
      hint = `${upstream} recusou conexão — serviço desligado ou em outra porta.`
    } else if (e?.name === 'AbortError') {
      hint = `Timeout em ${url}.`
    }
    return {
      ok: false,
      error: e?.message || String(e),
      cause,
      hint,
      url,
      elapsedMs: Date.now() - startMs,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Lista as últimas mensagens de um lead diretamente do dispatcher.
 *
 * @param {Record<string,string>} env
 * @param {number|string} leadId
 * @param {{ limit?: number, order?: 'asc'|'desc' }} [opts]
 * @returns {Promise<{ ok: boolean, status?: number, messages: any[], error?: string, requestUrl?: string, elapsedMs?: number }>}
 */
export async function getMessagesByLead(env, leadId, opts = {}) {
  const lid = Number(leadId)
  if (!Number.isFinite(lid) || lid <= 0) {
    return { ok: false, code: 'MISSING_LEAD_ID', error: 'leadId inválido', messages: [] }
  }
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 30))
  const order = opts.order === 'asc' ? 'asc' : 'desc'
  const path = `/api/kommo/messages/by-lead/${lid}?limit=${limit}&order=${order}`
  const r = await dispatcherFetch(env, path)
  if (!r.ok) {
    const errMsg = r.error || (typeof r.raw === 'string' ? r.raw.slice(0, 300) : `status ${r.status}`)
    return {
      ok: false,
      status: r.status,
      error: errMsg,
      cause: r.cause || null,
      hint: r.hint || null,
      messages: [],
      requestUrl: r.url,
      elapsedMs: r.elapsedMs,
    }
  }
  // Resposta atual do dispatcher é um array direto. Se um dia mudar para
  // { messages: [...] }, aceitamos os dois.
  const messages = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.messages) ? r.data.messages : []
  return { ok: true, status: r.status, messages, requestUrl: r.url, elapsedMs: r.elapsedMs }
}

/**
 * Força o dispatcher a re-sincronizar mensagens desse lead com o Kommo
 * (Playwright/scraping). Pode ser lento (>15s); só use se realmente
 * precisar — o dispatcher já tem polling próprio.
 *
 * @param {Record<string,string>} env
 * @param {number|string} leadId
 * @returns {Promise<{ ok: boolean, status?: number, error?: string, data?: any, requestUrl?: string }>}
 */
export async function triggerLeadSync(env, leadId) {
  const lid = Number(leadId)
  if (!Number.isFinite(lid) || lid <= 0) {
    return { ok: false, error: 'leadId inválido' }
  }
  const r = await dispatcherFetch(env, `/api/kommo/messages/sync/${lid}`, {
    method: 'POST',
    timeoutMs: 30000,
  })
  return {
    ok: r.ok,
    status: r.status,
    error: r.error || null,
    data: r.data,
    requestUrl: r.url,
    elapsedMs: r.elapsedMs,
  }
}
