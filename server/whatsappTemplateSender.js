/**
 * Envio de templates WhatsApp Cloud API (Meta).
 */

import { createLeadNote } from './kommoClient.js'
import { generateExecutionId } from './ai/executionTelemetry.js'

function getConfig(env) {
  return {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v19.0',
    templateName: String(env.WHATSAPP_TEMPLATE_FORM_SUMAR || 'form_sumar').trim(),
    templateLang: String(env.WHATSAPP_TEMPLATE_FORM_SUMAR_LANG || 'pt_BR').trim(),
  }
}

function digitsOnly(input) {
  return String(input || '').split('@')[0].replace(/[^0-9]/g, '')
}

/**
 * Template "Form Sumar" — formulário de dados básicos antes do consultor.
 * Nome no Meta costuma ser minúsculo (form_sumar); override via env.
 *
 * @param {Record<string,string>} env
 * @param {{ to: string, leadId?: number|string, executionId?: string }} params
 */
export async function sendFormSumarTemplate(env, { to, leadId, executionId }) {
  const cfg = getConfig(env)
  if (!cfg.phoneNumberId || !cfg.accessToken) {
    return {
      ok: false,
      code: 'WHATSAPP_NOT_CONFIGURED',
      error: 'Configure WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN.',
    }
  }
  const recipient = digitsOnly(to)
  if (!recipient) return { ok: false, code: 'MISSING_TO', error: 'destinatário vazio' }

  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'template',
    template: {
      name: cfg.templateName,
      language: { code: cfg.templateLang },
    },
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.accessToken}`,
      },
      body: JSON.stringify(body),
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
        code: 'WHATSAPP_TEMPLATE_FAILED',
        status: res.status,
        template: cfg.templateName,
        error: typeof raw === 'string' ? raw.slice(0, 500) : 'unknown',
      }
    }
    const messageId = data?.messages?.[0]?.id || null
    const execId = executionId || generateExecutionId()
    if (leadId != null && leadId !== '') {
      const note = await createLeadNote(
        env,
        leadId,
        `Template WhatsApp "${cfg.templateName}" enviado (Form Sumar) — ${execId}`,
      )
      if (!note.ok) {
        console.warn(`[whatsappTemplate] nota Kommo falhou: ${note.error || note.status}`)
      }
    }
    return {
      ok: true,
      status: res.status,
      messageId,
      template: cfg.templateName,
      executionId: execId,
    }
  } catch (e) {
    return { ok: false, code: 'WHATSAPP_FETCH_FAILED', error: e.message }
  }
}
