/**
 * Envio de texto via Evolution API (mesma instância que recebe webhooks).
 *
 * POST {EVOLUTION_API_URL}/message/sendText/{instance}
 * Header: apikey: {EVOLUTION_API_KEY}
 * Body:   { "number": "5511999999999", "text": "..." }
 *
 * Útil quando a instância está ligada ao WhatsApp Business e você quer
 * garantir que a saída seja pela mesma sessão Evolution (em paralelo ao
 * caminho Meta Cloud em `whatsappSender.sendText`).
 */

import { digitsToWhatsAppLocalPart } from '../phoneWhatsApp.js'

function getConfig(env) {
  return {
    url: String(env.EVOLUTION_API_URL || '').replace(/\/$/, ''),
    apiKey: env.EVOLUTION_API_KEY || '',
    instance: env.EVOLUTION_INSTANCE || env.EVOLUTION_INSTANCE_NAME || '',
  }
}

/**
 * @param {Record<string,string>} env
 * @param {{ to: string, text: string }} params — `to` aceita JID ou dígitos
 * @returns {Promise<{ ok: boolean, status?: number, messageId?: string|null, code?: string, error?: string }>}
 */
export async function sendTextViaEvolution(env, { to, text }) {
  const cfg = getConfig(env)
  if (!cfg.url || !cfg.apiKey || !cfg.instance) {
    return {
      ok: false,
      code: 'EVOLUTION_NOT_CONFIGURED',
      error: 'Configure EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE.',
    }
  }

  const number = digitsToWhatsAppLocalPart(to)
  if (!number) {
    return { ok: false, code: 'MISSING_TO', error: 'destinatário vazio' }
  }
  const body = String(text || '')
  if (!body.trim()) {
    return { ok: false, code: 'EMPTY_BODY', error: 'texto vazio' }
  }

  const url = `${cfg.url}/message/sendText/${encodeURIComponent(cfg.instance)}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.apiKey,
      },
      body: JSON.stringify({ number, text: body }),
    })
    const raw = await res.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = raw
    }
    if (!res.ok) {
      const errSlice = typeof raw === 'string' ? raw.slice(0, 500) : 'unknown'
      return {
        ok: false,
        code: 'EVOLUTION_SEND_FAILED',
        status: res.status,
        error: errSlice,
      }
    }
    const messageId = data?.key?.id || data?.message?.key?.id || null
    return { ok: true, status: res.status, messageId }
  } catch (e) {
    return { ok: false, code: 'EVOLUTION_FETCH_FAILED', error: e.message }
  }
}
