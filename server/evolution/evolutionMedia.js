/**
 * Download de mídia (áudio / imagem / documento) via Evolution API.
 *
 * Por que existe:
 *   Em instâncias Evolution rodando em modo WhatsApp Cloud (Meta API),
 *   o webhook `messages.upsert` NÃO inclui o `base64` do conteúdo
 *   inline — só vem metadata (mimeType, url criptografada, mediaKey).
 *   Pra transcrever áudio com Whisper / analisar imagem com Vision, a
 *   gente precisa baixar os bytes via Evolution.
 *
 *   Em modo Baileys, normalmente o base64 já vem inline em
 *   `data.message.base64` — neste caso este módulo nem é chamado.
 *
 * Endpoint: POST {EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/{instance}
 * Header:   apikey: {EVOLUTION_API_KEY}
 * Body:     { message: { key: { ... } }, convertToMp4: false }
 * Response: 200 → { base64, mimetype, fileName }
 *
 * Envs (mesmas usadas pelo typingIndicator):
 *   EVOLUTION_API_URL
 *   EVOLUTION_API_KEY
 *   EVOLUTION_INSTANCE (ou EVOLUTION_INSTANCE_NAME)
 */

function getConfig(env) {
  return {
    url: String(env.EVOLUTION_API_URL || '').replace(/\/$/, ''),
    apiKey: env.EVOLUTION_API_KEY || '',
    defaultInstance: env.EVOLUTION_INSTANCE || env.EVOLUTION_INSTANCE_NAME || '',
  }
}

import { getEvolutionInstanceName, normalizeEvolutionInstance } from './instanceConfig.js'

/**
 * Resolve o nome da instância a partir do payload + env. A Evolution
 * coloca em diferentes níveis dependendo da versão.
 */
export function resolveInstanceName(env, payload) {
  const raw =
    payload?.instance ||
    payload?.body?.instance ||
    payload?.data?.instance ||
    null
  const normalized = normalizeEvolutionInstance(env, raw)
  if (normalized) return normalized
  return getEvolutionInstanceName(env) || null
}

/**
 * Baixa o conteúdo binário de uma mensagem de mídia via Evolution e
 * devolve como base64. Best-effort com timeout duro de 15s.
 *
 * @param {Record<string,string>} env
 * @param {object} params
 * @param {string} params.instance         Nome da instância (Evolution).
 * @param {object} params.payload          payload bruto recebido no webhook
 *                                         (espera-se `data.key.{id, remoteJid, fromMe}`).
 * @returns {Promise<{ok: true, base64: string, mimetype: string|null, fileName: string|null}
 *  | {ok: false, code: string, status?: number, error: string}>}
 */
export async function fetchEvolutionMediaBase64(env, { instance, payload } = {}) {
  const cfg = getConfig(env)
  const inst = instance || cfg.defaultInstance
  if (!cfg.url || !cfg.apiKey || !inst) {
    return {
      ok: false,
      code: 'EVOLUTION_NOT_CONFIGURED',
      error: 'Configure EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE.',
    }
  }
  const d = payload?.data || payload || {}
  const key = d?.key
  if (!key || !key.id) {
    return {
      ok: false,
      code: 'NO_MESSAGE_KEY',
      error: 'payload.data.key.id ausente — Evolution não consegue localizar a mídia.',
    }
  }

  const url = `${cfg.url}/chat/getBase64FromMediaMessage/${encodeURIComponent(inst)}`
  // Body aceita tanto { message: { key } } quanto { message: <data inteiro> }
  // dependendo da versão. A estrutura mais tolerante usa o `data` inteiro,
  // que costuma ter `message.audioMessage` etc — algumas versões da
  // Evolution validam isso e devolvem 400 se passar só a key.
  const body = {
    message: d,
    convertToMp4: false,
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  const startMs = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.apiKey,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const elapsedMs = Date.now() - startMs
    const raw = await res.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { data = null }

    if (!res.ok) {
      // Tenta de novo com `{ message: { key } }` — algumas versões
      // da Evolution preferem esse formato e rejeitam `{ message: data }`.
      if (res.status === 400 || res.status === 422) {
        return await retryWithKeyOnly({ url, apiKey: cfg.apiKey, key, elapsedMs })
      }
      return {
        ok: false,
        code: 'EVOLUTION_MEDIA_FAILED',
        status: res.status,
        error: typeof raw === 'string' ? raw.slice(0, 400) : '',
        elapsedMs,
      }
    }
    if (data?.base64) {
      return {
        ok: true,
        base64: stripDataUrlPrefix(data.base64),
        mimetype: data.mimetype || null,
        fileName: data.fileName || null,
        elapsedMs,
      }
    }
    return {
      ok: false,
      code: 'NO_BASE64_IN_RESPONSE',
      status: res.status,
      error: JSON.stringify(data || {}).slice(0, 200),
      elapsedMs,
    }
  } catch (e) {
    const elapsedMs = Date.now() - startMs
    const aborted = e?.name === 'AbortError'
    return {
      ok: false,
      code: aborted ? 'EVOLUTION_TIMEOUT' : 'FETCH_FAILED',
      error: aborted ? `timeout após ${elapsedMs}ms` : e.message,
      elapsedMs,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function retryWithKeyOnly({ url, apiKey, key, elapsedMs: prevMs }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  const startMs = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: apiKey,
      },
      body: JSON.stringify({ message: { key }, convertToMp4: false }),
      signal: ctrl.signal,
    })
    const elapsedMs = (prevMs || 0) + (Date.now() - startMs)
    const raw = await res.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { data = null }
    if (!res.ok) {
      return {
        ok: false,
        code: 'EVOLUTION_MEDIA_FAILED',
        status: res.status,
        error: typeof raw === 'string' ? raw.slice(0, 400) : '',
        elapsedMs,
        retried: true,
      }
    }
    if (data?.base64) {
      return {
        ok: true,
        base64: stripDataUrlPrefix(data.base64),
        mimetype: data.mimetype || null,
        fileName: data.fileName || null,
        elapsedMs,
        retried: true,
      }
    }
    return {
      ok: false,
      code: 'NO_BASE64_IN_RESPONSE',
      status: res.status,
      error: JSON.stringify(data || {}).slice(0, 200),
      elapsedMs,
      retried: true,
    }
  } catch (e) {
    const elapsedMs = (prevMs || 0) + (Date.now() - startMs)
    const aborted = e?.name === 'AbortError'
    return {
      ok: false,
      code: aborted ? 'EVOLUTION_TIMEOUT' : 'FETCH_FAILED',
      error: aborted ? `timeout após ${elapsedMs}ms (retry)` : e.message,
      elapsedMs,
      retried: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

function stripDataUrlPrefix(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/^data:[^;]+;base64,/, '')
}

/**
 * Inspeciona o payload e devolve TODOS os caminhos onde o base64
 * pode estar inline. Útil pra log de diagnóstico quando o download
 * falha — o operador consegue entender o formato real que a
 * Evolution está enviando.
 */
export function describeMediaPayloadShape(payload) {
  const d = payload?.data || payload || {}
  const m = d?.message || {}
  const has = (v) => (typeof v === 'string' && v.length > 0 ? v.length : 0)
  return {
    'data.message.base64': has(m.base64),
    'data.message.mediaBase64': has(m.mediaBase64),
    'data.message.audioMessage.base64': has(m?.audioMessage?.base64),
    'data.message.imageMessage.base64': has(m?.imageMessage?.base64),
    'data.message.audioMessage.url': m?.audioMessage?.url ? 'url' : 0,
    'data.message.imageMessage.url': m?.imageMessage?.url ? 'url' : 0,
    'data.key.id': d?.key?.id || 0,
    messageType: d?.messageType || null,
    messageKeys: Object.keys(m).slice(0, 20),
  }
}
