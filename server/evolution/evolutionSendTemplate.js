/**
 * Envio de template via Evolution API (WhatsApp Business / Cloud na instância).
 *
 * POST {EVOLUTION_API_URL}/message/sendTemplate/{instance}
 * Header: apikey: {EVOLUTION_API_KEY}
 */

import { digitsToWhatsAppLocalPart } from '../phoneWhatsApp.js'

export function isEvolutionTemplateConfigured(env) {
  const url = String(env.EVOLUTION_API_URL || '').replace(/\/$/, '')
  const apiKey = env.EVOLUTION_API_KEY || ''
  const instance = env.EVOLUTION_INSTANCE || env.EVOLUTION_INSTANCE_NAME || ''
  return Boolean(url && apiKey && instance)
}

function getConfig(env) {
  return {
    url: String(env.EVOLUTION_API_URL || '').replace(/\/$/, ''),
    apiKey: env.EVOLUTION_API_KEY || '',
    instance: env.EVOLUTION_INSTANCE || env.EVOLUTION_INSTANCE_NAME || '',
  }
}

/**
 * @param {Record<string,string>} env
 * @param {{ to: string, templateName: string, templateLang?: string, components?: object[] }} params
 */
export async function sendTemplateViaEvolution(env, { to, templateName, templateLang = 'pt_BR', components }) {
  const cfg = getConfig(env)
  if (!cfg.url || !cfg.apiKey || !cfg.instance) {
    return {
      ok: false,
      code: 'EVOLUTION_NOT_CONFIGURED',
      error: 'Configure EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE.',
    }
  }
  const number = digitsToWhatsAppLocalPart(to)
  if (!number) return { ok: false, code: 'MISSING_TO', error: 'destinatário vazio' }
  if (!templateName) return { ok: false, code: 'MISSING_TEMPLATE', error: 'nome do template vazio' }

  const templateMessage = {
    name: templateName,
    language: templateLang,
  }
  if (Array.isArray(components) && components.length > 0) {
    templateMessage.components = components
  }

  const url = `${cfg.url}/message/sendTemplate/${encodeURIComponent(cfg.instance)}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.apiKey,
      },
      body: JSON.stringify({ number, templateMessage }),
    })
    const raw = await res.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = raw
    }
    if (!res.ok) {
      return {
        ok: false,
        code: 'EVOLUTION_TEMPLATE_FAILED',
        status: res.status,
        template: templateName,
        channel: 'evolution',
        error: typeof raw === 'string' ? raw.slice(0, 500) : 'unknown',
        data,
      }
    }
    const messageId = data?.key?.id || data?.message?.key?.id || data?.messages?.[0]?.id || null
    return { ok: true, status: res.status, messageId, template: templateName, channel: 'evolution', data }
  } catch (e) {
    return { ok: false, code: 'EVOLUTION_FETCH_FAILED', channel: 'evolution', error: e.message, template: templateName }
  }
}
