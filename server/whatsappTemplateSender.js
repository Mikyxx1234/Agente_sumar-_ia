/**
 * Envio do template WhatsApp "Form Sumar".
 * Tenta Meta Cloud API e Evolution; para templates com botão Flow, reenvia com components.
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

function shouldAutoTryFlowComponents(env) {
  const v = String(env.WHATSAPP_TEMPLATE_FORM_SUMAR_AUTO_FLOW ?? 'true').trim().toLowerCase()
  return !(v === 'false' || v === '0' || v === 'no' || v === 'off')
}

/** Componente padrão para template com botão WhatsApp Flow (Formulário). */
export function buildFlowButtonComponents(env) {
  const index = String(env.WHATSAPP_TEMPLATE_FORM_SUMAR_FLOW_BUTTON_INDEX || '0').trim()
  const flowToken = String(env.WHATSAPP_TEMPLATE_FORM_SUMAR_FLOW_TOKEN || 'unused').trim()
  return [
    {
      type: 'button',
      sub_type: 'flow',
      index,
      parameters: [
        {
          type: 'action',
          action: {
            flow_token: flowToken,
          },
        },
      ],
    },
  ]
}

function parseMetaApiError(raw, data) {
  const err = data?.error || (typeof data === 'object' && data?.error)
  if (err && typeof err === 'object') {
    return {
      message: err.message,
      code: err.code,
      subcode: err.error_subcode,
      type: err.type,
      fbtrace_id: err.fbtrace_id,
    }
  }
  return { message: typeof raw === 'string' ? raw.slice(0, 300) : 'unknown' }
}

/** Indica se vale tentar de novo com botão Flow (nome errado não adianta). */
function shouldRetryWithFlowComponents(metaErr) {
  const msg = String(metaErr?.message || '').toLowerCase()
  const code = Number(metaErr?.code)
  if (code === 132001) return false
  if (/does not exist|não existe|not found|template name/i.test(msg)) return false
  if (/parameter|component|button|flow|missing|required|132000|131008/i.test(msg)) return true
  return true
}

export function getFormSumarTemplateConfig(env) {
  const lang = String(env.WHATSAPP_TEMPLATE_FORM_SUMAR_LANG || 'pt_BR').trim()
  const namesRaw =
    env.WHATSAPP_TEMPLATE_FORM_SUMAR_NAMES ||
    env.WHATSAPP_TEMPLATE_FORM_SUMAR ||
    'form_sumar,formulario_sum,formulario_sumar,formulario_sum'
  const templateNames = String(namesRaw)
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter(Boolean)
  const customComponents = parseTemplateComponents(env)
  return {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v19.0',
    wabaId: env.WHATSAPP_WABA_ID || env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    outboundMode: String(env.WHATSAPP_OUTBOUND_MODE || 'cloud').toLowerCase().trim(),
    templateNames: templateNames.length ? templateNames : ['form_sumar'],
    templateLang: lang,
    customComponents,
    autoFlow: shouldAutoTryFlowComponents(env),
    flowComponents: buildFlowButtonComponents(env),
    cloudReady: Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN),
    evolutionReady: isEvolutionTemplateConfigured(env),
  }
}

/** Lista modelos aprovados no Meta (ajuda a achar o nome técnico exato). */
export async function listMetaMessageTemplates(env, { limit = 50 } = {}) {
  const cfg = getFormSumarTemplateConfig(env)
  if (!cfg.cloudReady) {
    return { ok: false, code: 'WHATSAPP_NOT_CONFIGURED', templates: [] }
  }
  let wabaId = cfg.wabaId
  try {
    if (!wabaId) {
      const pr = await fetch(
        `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}?fields=whatsapp_business_account`,
        { headers: { Authorization: `Bearer ${cfg.accessToken}` } },
      )
      const prRaw = await pr.text()
      let prData = null
      try {
        prData = prRaw ? JSON.parse(prRaw) : null
      } catch {
        prData = null
      }
      wabaId = prData?.whatsapp_business_account?.id || prData?.whatsapp_business_account
      if (typeof wabaId === 'object' && wabaId?.id) wabaId = wabaId.id
    }
    if (!wabaId) {
      return {
        ok: false,
        code: 'WABA_ID_UNKNOWN',
        error: 'Defina WHATSAPP_WABA_ID ou conceda permissão para ler whatsapp_business_account do número.',
        templates: [],
      }
    }
    const q = new URLSearchParams({ limit: String(Math.min(100, limit)), fields: 'name,status,language,category,components' })
    const res = await fetch(
      `https://graph.facebook.com/${cfg.apiVersion}/${wabaId}/message_templates?${q}`,
      { headers: { Authorization: `Bearer ${cfg.accessToken}` } },
    )
    const raw = await res.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        wabaId,
        error: parseMetaApiError(raw, data),
        templates: [],
      }
    }
    const templates = (data?.data || []).map((t) => ({
      name: t.name,
      status: t.status,
      language: t.language,
      category: t.category,
      hasFlowButton: (t.components || []).some(
        (c) => c.type === 'BUTTONS' && (c.buttons || []).some((b) => b.type === 'FLOW'),
      ),
    }))
    return { ok: true, wabaId, templates }
  } catch (e) {
    return { ok: false, error: e.message, templates: [] }
  }
}

/** Diagnóstico rápido (health / painel). */
export async function diagnoseFormSumarTemplate(env, { listTemplates = true } = {}) {
  const cfg = getFormSumarTemplateConfig(env)
  const channels = []
  if (cfg.cloudReady) channels.push('cloud')
  if (cfg.evolutionReady) channels.push('evolution')

  const out = {
    ok: channels.length > 0,
    channels,
    templateNames: cfg.templateNames,
    templateLang: cfg.templateLang,
    outboundMode: cfg.outboundMode,
    autoFlowRetry: cfg.autoFlow,
    hasCustomComponents: Boolean(cfg.customComponents?.length),
    configuredNamesMatchMeta: null,
    metaTemplates: null,
    hint:
      channels.length === 0
        ? 'Configure WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN e/ou EVOLUTION_API_* + EVOLUTION_INSTANCE.'
        : null,
  }

  if (listTemplates && cfg.cloudReady) {
    const listed = await listMetaMessageTemplates(env)
    out.metaTemplates = listed
    if (listed.ok && listed.templates?.length) {
      const approved = listed.templates.filter((t) => t.status === 'APPROVED')
      const names = new Set(approved.map((t) => t.name))
      const flowTemplates = approved.filter((t) => t.hasFlowButton).map((t) => t.name)
      out.configuredNamesMatchMeta = cfg.templateNames.map((n) => ({
        name: n,
        approved: names.has(n),
      }))
      if (flowTemplates.length && !out.hint) {
        out.hint = `Templates com botão Flow no Meta: ${flowTemplates.join(', ')}. Use um desses nomes em WHATSAPP_TEMPLATE_FORM_SUMAR_NAMES.`
      }
      const noneMatch = out.configuredNamesMatchMeta.every((x) => !x.approved)
      if (noneMatch && approved.length) {
        out.hint = `Nenhum nome em WHATSAPP_TEMPLATE_FORM_SUMAR_NAMES está aprovado. Sugestão: ${approved
          .slice(0, 5)
          .map((t) => t.name)
          .join(', ')}`
      }
    }
  }

  return out
}

function buildCloudPayload(cfg, recipient, templateName, components) {
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
  if (components?.length) {
    body.template.components = components
  }
  return body
}

async function sendOneTemplateCloud(cfg, recipient, templateName, components, variantLabel) {
  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`
  const body = buildCloudPayload(cfg, recipient, templateName, components)
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
  return { res, raw, data, templateName, variantLabel }
}

function cloudVariants(cfg, env) {
  const variants = []
  if (cfg.customComponents?.length) {
    variants.push({ components: cfg.customComponents, label: 'custom' })
  }
  variants.push({ components: null, label: 'plain' })
  if (cfg.autoFlow) {
    variants.push({ components: cfg.flowComponents, label: 'flow_button' })
  }
  return variants
}

function digitsOnly(input) {
  return String(input || '').split('@')[0].replace(/[^0-9]/g, '')
}

async function noteTemplateSent(env, { leadId, templateName, execId, channel, variant }) {
  if (leadId == null || leadId === '') return
  const note = await createLeadNote(
    env,
    leadId,
    `Template WhatsApp "${templateName}" enviado (Form Sumar, ${channel}${variant ? `, ${variant}` : ''}) — ${execId}`,
  )
  if (!note.ok) {
    console.warn(`[whatsappTemplate] nota Kommo falhou: ${note.error || note.status}`)
  }
}

async function tryCloudTemplates(env, cfg, recipient, { leadId, executionId }) {
  if (!cfg.cloudReady) return null
  let lastFail = null

  for (const templateName of cfg.templateNames) {
    for (const variant of cloudVariants(cfg, env)) {
      const { res, raw, data, variantLabel } = await sendOneTemplateCloud(
        cfg,
        recipient,
        templateName,
        variant.components,
        variant.label,
      )
      if (res.ok) {
        const messageId = data?.messages?.[0]?.id || null
        const execId = executionId || generateExecutionId()
        console.log(
          `[whatsappTemplate] Form Sumar OK channel=cloud template=${templateName} variant=${variantLabel} to=…${recipient.slice(-4)}`,
        )
        await noteTemplateSent(env, {
          leadId,
          templateName,
          execId,
          channel: 'cloud',
          variant: variantLabel,
        })
        return {
          ok: true,
          status: res.status,
          messageId,
          template: templateName,
          channel: 'cloud',
          variant: variantLabel,
          executionId: execId,
        }
      }

      const metaErr = parseMetaApiError(raw, data)
      lastFail = {
        ok: false,
        code: 'WHATSAPP_TEMPLATE_FAILED',
        status: res.status,
        template: templateName,
        channel: 'cloud',
        variant: variantLabel,
        metaError: metaErr,
        error: typeof raw === 'string' ? raw.slice(0, 500) : 'unknown',
      }
      console.warn(
        `[whatsappTemplate] cloud falhou template=${templateName} variant=${variantLabel} status=${res.status} meta=${JSON.stringify(metaErr)}`,
      )

      if (variant.label === 'plain' && cfg.autoFlow && shouldRetryWithFlowComponents(metaErr)) {
        continue
      }
    }
  }
  return lastFail
}

async function tryEvolutionTemplates(env, cfg, recipient, { leadId, executionId }) {
  if (!cfg.evolutionReady) return null
  let lastFail = null

  for (const templateName of cfg.templateNames) {
    const componentSets = [
      { components: cfg.customComponents, label: 'custom' },
      { components: null, label: 'plain' },
    ]
    if (cfg.autoFlow) {
      componentSets.push({ components: cfg.flowComponents, label: 'flow_button' })
    }

    for (const { components, label } of componentSets) {
      if (label === 'custom' && !components?.length) continue

      const evo = await sendTemplateViaEvolution(env, {
        to: recipient,
        templateName,
        templateLang: cfg.templateLang,
        components,
      })
      if (evo.ok) {
        const execId = executionId || generateExecutionId()
        console.log(
          `[whatsappTemplate] Form Sumar OK channel=evolution template=${templateName} variant=${label} to=…${recipient.slice(-4)}`,
        )
        await noteTemplateSent(env, { leadId, templateName, execId, channel: 'evolution', variant: label })
        return {
          ok: true,
          status: evo.status,
          messageId: evo.messageId,
          template: templateName,
          channel: 'evolution',
          variant: label,
          executionId: execId,
        }
      }
      lastFail = { ...evo, variant: label }
      console.warn(
        `[whatsappTemplate] evolution falhou template=${templateName} variant=${label} status=${evo.status} err=${String(evo.error || '').slice(0, 200)}`,
      )
    }
  }
  return lastFail
}

/**
 * Template "Form Sumar" — formulário de dados básicos antes do consultor.
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
        'Template Form Sumar: configure WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN (Meta) e/ou EVOLUTION_API_* + EVOLUTION_INSTANCE.',
      diagnose: await diagnoseFormSumarTemplate(env, { listTemplates: false }),
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
    return {
      ...(lastFail || {
        ok: false,
        code: 'WHATSAPP_TEMPLATE_FAILED',
        error: 'Nenhum canal conseguiu enviar o template.',
      }),
      diagnose: await diagnoseFormSumarTemplate(env),
    }
  } catch (e) {
    return { ok: false, code: 'WHATSAPP_FETCH_FAILED', error: e.message }
  }
}
