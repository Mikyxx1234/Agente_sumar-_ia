/**
 * Envio de templates WhatsApp Cloud API (Meta).
 */

import { createLeadNote } from './kommoClient.js'
import { generateExecutionId } from './ai/executionTelemetry.js'

function getConfig(env) {
  const lang = String(env.WHATSAPP_TEMPLATE_FORM_SUMAR_LANG || 'pt_BR').trim()
  const namesRaw =
    env.WHATSAPP_TEMPLATE_FORM_SUMAR_NAMES ||
    env.WHATSAPP_TEMPLATE_FORM_SUMAR ||
    'form_sumar,formulario_sum,formulario_sumar,form_sumar'
  const templateNames = String(namesRaw)
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter(Boolean)
  return {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v19.0',
    templateNames: templateNames.length ? templateNames : ['form_sumar'],
    templateLang: lang,
  }
}

async function sendOneTemplate(cfg, recipient, templateName) {
  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: cfg.templateLang },
      },
    }),
  })
  const raw = await res.text()
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = raw
  }
  return { res, raw, data, templateName }
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

  let lastFail = null
  try {
    for (const templateName of cfg.templateNames) {
      const { res, raw, data, templateName: tried } = await sendOneTemplate(cfg, recipient, templateName)
      if (res.ok) {
        const messageId = data?.messages?.[0]?.id || null
        const execId = executionId || generateExecutionId()
        console.log(`[whatsappTemplate] Form Sumar enviado template=${tried} to=${recipient.slice(-4)}`)
        if (leadId != null && leadId !== '') {
          const note = await createLeadNote(
            env,
            leadId,
            `Template WhatsApp "${tried}" enviado (Form Sumar) — ${execId}`,
          )
          if (!note.ok) {
            console.warn(`[whatsappTemplate] nota Kommo falhou: ${note.error || note.status}`)
          }
        }
        return {
          ok: true,
          status: res.status,
          messageId,
          template: tried,
          executionId: execId,
        }
      }
      lastFail = {
        ok: false,
        code: 'WHATSAPP_TEMPLATE_FAILED',
        status: res.status,
        template: tried,
        error: typeof raw === 'string' ? raw.slice(0, 500) : 'unknown',
      }
      console.warn(`[whatsappTemplate] falhou template=${tried} status=${res.status} err=${lastFail.error?.slice(0, 120)}`)
    }
    return (
      lastFail || {
        ok: false,
        code: 'WHATSAPP_TEMPLATE_FAILED',
        error: 'Nenhum nome de template configurado.',
      }
    )
  } catch (e) {
    return { ok: false, code: 'WHATSAPP_FETCH_FAILED', error: e.message }
  }
}
