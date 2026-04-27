/**
 * Indicador "digitando..." (typing presence) via Evolution API.
 *
 * Por que Evolution e não Cloud API:
 *   - Recebemos as mensagens do cliente via webhook da Evolution. A
 *     Evolution mantém a conexão WhatsApp que pode emitir presença
 *     ("composing", "paused", etc) pro JID do cliente.
 *   - O typing indicator da Cloud API (Meta) exige o `message_id` (wamid)
 *     da mensagem recebida; como a gente recebe via Evolution, não temos
 *     esse wamid e não conseguimos usar o endpoint da Meta pra typing.
 *
 * Endpoint: POST {EVOLUTION_API_URL}/chat/sendPresence/{instance}
 * Body:    { number, delay, presence }
 * Header:  apikey: {EVOLUTION_API_KEY}
 *
 * O typing dura por volta de 6–10 segundos no cliente Whatsapp; pra
 * cobrir todo o ciclo (debounce + agente + envio) a gente refire em
 * vários pontos do fluxo (cada nova msg no buffer + início do flush).
 *
 * Env:
 *   EVOLUTION_API_URL        ex: https://evolution.meudominio.com
 *   EVOLUTION_API_KEY        api key do server da Evolution
 *   EVOLUTION_INSTANCE       nome da instância (mesmo da Evolution UI)
 *   EVOLUTION_TYPING_DELAY_MS opcional (default 1200)
 */

function getConfig(env) {
  const delay = Number(env.EVOLUTION_TYPING_DELAY_MS)
  return {
    url: (env.EVOLUTION_API_URL || '').replace(/\/$/, ''),
    apiKey: env.EVOLUTION_API_KEY || '',
    instance: env.EVOLUTION_INSTANCE || env.EVOLUTION_INSTANCE_NAME || '',
    defaultDelay: Number.isFinite(delay) && delay >= 0 ? Math.floor(delay) : 1200,
  }
}

/**
 * Manda presença de "digitando" pro JID. Best-effort.
 *
 * @param {Record<string,string>} env
 * @param {object} params
 * @param {string} params.jid                   JID completo (`...@s.whatsapp.net`) ou só dígitos.
 * @param {('composing'|'paused'|'available'|'unavailable'|'recording')} [params.presence]  default: composing
 * @param {number} [params.delayMs]             quanto tempo (ms) o cliente vê o indicador
 * @returns {Promise<{ok, status?, code?, error?, data?}>}
 */
export async function sendTyping(env, { jid, presence = 'composing', delayMs } = {}) {
  const cfg = getConfig(env)
  if (!cfg.url || !cfg.apiKey || !cfg.instance) {
    return { ok: false, code: 'EVOLUTION_NOT_CONFIGURED', error: 'Configure EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE.' }
  }
  if (!jid) return { ok: false, code: 'MISSING_JID', error: 'jid ausente' }

  const number = String(jid).includes('@') ? String(jid) : `${String(jid).replace(/[^0-9]/g, '')}@s.whatsapp.net`
  const delay = Number.isFinite(delayMs) && delayMs >= 0 ? Math.floor(delayMs) : cfg.defaultDelay

  try {
    const res = await fetch(`${cfg.url}/chat/sendPresence/${encodeURIComponent(cfg.instance)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.apiKey,
      },
      body: JSON.stringify({ number, delay, presence }),
    })
    const raw = await res.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
    if (!res.ok) {
      return { ok: false, status: res.status, code: 'EVOLUTION_PRESENCE_FAILED', error: typeof raw === 'string' ? raw.slice(0, 400) : '' }
    }
    return { ok: true, status: res.status, data }
  } catch (e) {
    return { ok: false, code: 'EVOLUTION_FETCH_FAILED', error: e.message }
  }
}

/**
 * Versão fire-and-forget: dispara o typing sem bloquear o fluxo.
 * Loga warning só se algo deu errado E a Evolution está configurada.
 * Útil pra chamar dentro de handlers HTTP sem await.
 */
export function fireTyping(env, params, label = 'typing') {
  return sendTyping(env, params)
    .then((r) => {
      if (!r.ok && r.code !== 'EVOLUTION_NOT_CONFIGURED') {
        console.warn(`[${label}] presence falhou: ${r.error || r.status}`)
      }
      return r
    })
    .catch((err) => {
      console.warn(`[${label}] presence exception: ${err.message}`)
      return { ok: false, error: err.message }
    })
}
