/**
 * Envio do template WhatsApp "Form Sumar".
 * Tenta Meta Cloud API e, se falhar, Evolution sendTemplate (mesma instância do webhook).
 */

import { createLeadNote } from './kommoClient.js'
import { generateExecutionId } from './ai/executionTelemetry.js'
import { isEvolutionTemplateConfigured, sendTemplateViaEvolution } from './evolution/evolutionSendTemplate.js'

function parseTemplateComponents(env) {
  const raw = String(env.WHATSAPP_TEMPLATE_FORM_SUMAR_COMPONENTS || '').trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    console.warn('[whatsappTemplate] WHATSAPP_TEMPLATE_FORM_SUMAR_COMPONENTS inválido (JSON)')
    return null
  }
}

export function getFormSumarTemplateConfig(env) {
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
    outboundMode: String(env.WHATSAPP_OUTBOUND_MODE || 'cloud').toLowerCase().trim(),
    templateNames: templateNames.length ? templateNames : ['form_sumar'],
    templateLang: lang,
    components: parseTemplateComponents(env),
    cloudReady: Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN),
    evolutionReady: isEvolutionTemplateConfigured(env),
  }
}

/** Diagnóstico rápido (health / painel). */
export function diagnoseFormSumarTemplate(env) {
  const cfg = getFormSumarTemplateConfig(env)
  const channels = []
  if (cfg.cloudReady) channels.push('cloud')
  if (cfg.evolutionReady) channels.push('evolution')
  return {
    ok: channels.length > 0,
    channels,
    templateNames: cfg.templateNames,
    templateLang: cfg.templateLang,
    outboundMode: cfg.outboundMode,
    hasComponents: Boolean(cfg.components?.length),
    hint:
      channels.length === 0
        ? 'Configure WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN e/ou EVOLUTION_API_* + EVOLUTION_INSTANCE.'
        : null,
  }
}

async function sendOneTemplateCloud(cfg, recipient, templateName) {
  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'template',
    template: {
      name: templateName,
      language: { code: cfg.templateLang },
    },
  }
  if (cfg.components?.length) {
    body.template.components = cfg.components
  }
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
  return { res, raw, data, templateName }
}

function digitsOnly(input) {
  return String(input || '').split('@')[0].replace(/[^0-9]/g, '')
}

async function noteTemplateSent(env, { leadId, templateName, execId, channel }) {
  if (leadId == null || leadId === '') return
  const note = await createLeadNote(
    env,
    leadId,
    `Template WhatsApp "${templateName}" enviado (Form Sumar, ${channel}) — ${execId}`,
  )
  if (!note.ok) {
    console.warn(`[whatsappTemplate] nota Kommo falhou: ${note.error || note.status}`)
  }
}

async function tryCloudTemplates(env, cfg, recipient, { leadId, executionId }) {
  if (!cfg.cloudReady) return null
  let lastFail = null
  for (const templateName of cfg.templateNames) {
    const { res, raw, data, templateName: tried } = await sendOneTemplateCloud(cfg, recipient, templateName)
    if (res.ok) {
      const messageId = data?.messages?.[0]?.id || null
      const execId = executionId || generateExecutionId()
      console.log(`[whatsappTemplate] Form Sumar OK channel=cloud template=${tried} to=…${recipient.slice(-4)}`)
      await noteTemplateSent(env, { leadId, templateName: tried, execId, channel: 'cloud' })
      return {
        ok: true,
        status: res.status,
        messageId,
        template: tried,
        channel: 'cloud',
        executionId: execId,
      }
    }
    lastFail = {
      ok: false,
      code: 'WHATSAPP_TEMPLATE_FAILED',
      status: res.status,
      template: tried,
      channel: 'cloud',
      error: typeof raw === 'string' ? raw.slice(0, 500) : 'unknown',
    }
    console.warn(
      `[whatsappTemplate] cloud falhou template=${tried} status=${res.status} err=${lastFail.error?.slice(0, 160)}`,
    )
  }
  return lastFail
}

async function tryEvolutionTemplates(env, cfg, recipient, { leadId, executionId }) {
  if (!cfg.evolutionReady) return null
  let lastFail = null
  for (const templateName of cfg.templateNames) {
    const evo = await sendTemplateViaEvolution(env, {
      to: recipient,
      templateName,
      templateLang: cfg.templateLang,
      components: cfg.components,
    })
    if (evo.ok) {
      const execId = executionId || generateExecutionId()
      console.log(`[whatsappTemplate] Form Sumar OK channel=evolution template=${templateName} to=…${recipient.slice(-4)}`)
      await noteTemplateSent(env, { leadId, templateName, execId, channel: 'evolution' })
      return {
        ok: true,
        status: evo.status,
        messageId: evo.messageId,
        template: templateName,
        channel: 'evolution',
        executionId: execId,
      }
    }
    lastFail = evo
    console.warn(
      `[whatsappTemplate] evolution falhou template=${templateName} status=${evo.status} err=${String(evo.error || '').slice(0, 160)}`,
    )
  }
  return lastFail
}

/**
 * Template "Form Sumar" — formulário de dados básicos antes do consultor.
 *
 * @param {Record<string,string>} env
 * @param {{ to: string, leadId?: number|string, executionId?: string }} params
 */
export async function sendFormSumarTemplate(env, { to, leadId, executionId }) {
  const cfg = getFormSumarTemplateConfig(env)
  const recipient = digitsOnly(to)
  if (!recipient) return { ok: false, code: 'MISSING_TO', error: 'destinatário vazio' }

  if (!cfg.cloudReady && !cfg.evolutionReady) {
    return {
      ok: false,
      code: 'WHATSAPP_NOT_CONFIGURED',
      error:
        'Template Form Sumar: configure WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN (Meta) e/ou EVOLUTION_API_URL + EVOLUTION_API_KEY + EVOLUTION_INSTANCE.',
      diagnose: diagnoseFormSumarTemplate(env),
    }
  }

  const preferEvolution = cfg.outboundMode === 'evolution' && cfg.evolutionReady
  const channels = preferEvolution ? ['evolution', 'cloud'] : ['cloud', 'evolution']

  let lastFail = null
  try {
    for (const ch of channels) {
      if (ch === 'cloud' && !cfg.cloudReady) continue
      if (ch === 'evolution' && !cfg.evolutionReady) continue
      const result =
        ch === 'cloud'
          ? await tryCloudTemplates(env, cfg, recipient, { leadId, executionId })
          : await tryEvolutionTemplates(env, cfg, recipient, { leadId, executionId })
      if (result?.ok) return result
      if (result) lastFail = result
    }
    return (
      lastFail || {
        ok: false,
        code: 'WHATSAPP_TEMPLATE_FAILED',
        error: 'Nenhum canal conseguiu enviar o template.',
        diagnose: diagnoseFormSumarTemplate(env),
      }
    )
  } catch (e) {
    return { ok: false, code: 'WHATSAPP_FETCH_FAILED', error: e.message }
  }
}
