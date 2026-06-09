/**
 * Envio de documento (PDF etc.) via Evolution API ou WhatsApp Cloud API.
 */
import { digitsToWhatsAppLocalPart } from '../phoneWhatsApp.js'

function getEvolutionConfig(env) {
  return {
    url: String(env.EVOLUTION_API_URL || '').replace(/\/$/, ''),
    apiKey: env.EVOLUTION_API_KEY || '',
    instance: env.EVOLUTION_INSTANCE || env.EVOLUTION_INSTANCE_NAME || '',
  }
}

function getCloudConfig(env) {
  return {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v19.0',
  }
}

async function sendDocumentViaEvolution(env, { to, buffer, fileName, caption, mimeType }) {
  const cfg = getEvolutionConfig(env)
  if (!cfg.url || !cfg.apiKey || !cfg.instance) {
    return { ok: false, code: 'EVOLUTION_NOT_CONFIGURED', error: 'Evolution não configurada.' }
  }
  const number = digitsToWhatsAppLocalPart(to)
  if (!number) return { ok: false, code: 'MISSING_TO', error: 'destinatário vazio' }

  const base64 = Buffer.from(buffer).toString('base64')
  const url = `${cfg.url}/message/sendMedia/${encodeURIComponent(cfg.instance)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
    body: JSON.stringify({
      number,
      mediatype: 'document',
      mimetype: mimeType || 'application/pdf',
      media: base64,
      fileName: fileName || 'documento.pdf',
      caption: caption || '',
    }),
  })
  const raw = await res.text()
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = raw
  }
  if (!res.ok) {
    return { ok: false, code: 'EVOLUTION_MEDIA_FAILED', status: res.status, error: raw.slice(0, 500) }
  }
  return { ok: true, status: res.status, messageId: data?.key?.id || null, channel: 'evolution' }
}

async function uploadCloudMedia(env, buffer, mimeType) {
  const cfg = getCloudConfig(env)
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', mimeType || 'application/pdf')
  form.append('file', new Blob([buffer], { type: mimeType || 'application/pdf' }), 'document.pdf')

  const res = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}` },
    body: form,
  })
  const raw = await res.text()
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  if (!res.ok) return { ok: false, error: raw.slice(0, 500) }
  return { ok: true, mediaId: data?.id }
}

async function sendDocumentViaCloud(env, { to, buffer, fileName, caption, mimeType }) {
  const cfg = getCloudConfig(env)
  if (!cfg.phoneNumberId || !cfg.accessToken) {
    return { ok: false, code: 'WHATSAPP_NOT_CONFIGURED', error: 'Cloud API não configurada.' }
  }
  const recipient = digitsToWhatsAppLocalPart(to)
  if (!recipient) return { ok: false, code: 'MISSING_TO', error: 'destinatário vazio' }

  const up = await uploadCloudMedia(env, buffer, mimeType)
  if (!up.ok) return { ok: false, code: 'WHATSAPP_MEDIA_UPLOAD_FAILED', error: up.error }

  const res = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'document',
      document: {
        id: up.mediaId,
        filename: fileName || 'documento.pdf',
        caption: caption || undefined,
      },
    }),
  })
  const raw = await res.text()
  if (!res.ok) return { ok: false, code: 'WHATSAPP_DOCUMENT_FAILED', status: res.status, error: raw.slice(0, 500) }
  let data = null
  try {
    data = JSON.parse(raw)
  } catch {
    data = null
  }
  return { ok: true, status: res.status, messageId: data?.messages?.[0]?.id || null, channel: 'cloud' }
}

/** @param {Record<string,string>} env */
export async function sendDocument(env, params) {
  const outbound = String(env.WHATSAPP_OUTBOUND_MODE || 'cloud').toLowerCase().trim()
  if (outbound === 'evolution') return sendDocumentViaEvolution(env, params)
  return sendDocumentViaCloud(env, params)
}

export async function sendGradePdfToLead(env, { telefone, leadId, introText, pdfBuffer, fileName, caption }) {
  const { sendMessageWithNote } = await import('../whatsappSender.js')
  const { createLeadNote } = await import('../kommoClient.js')
  const { generateExecutionId } = await import('../ai/executionTelemetry.js')

  const steps = []
  if (introText?.trim()) {
    const textRes = await sendMessageWithNote(env, { telefone, text: introText, leadId })
    steps.push({ step: 'intro_text', ...textRes })
    if (!textRes.ok && !textRes.deduped) return { ok: false, steps, error: textRes.error || 'falha texto intro' }
  }

  const docRes = await sendDocument(env, {
    to: telefone,
    buffer: pdfBuffer,
    fileName,
    caption: caption || fileName,
    mimeType: 'application/pdf',
  })
  steps.push({ step: 'document', ...docRes })
  if (!docRes.ok) return { ok: false, steps, error: docRes.error || 'falha envio pdf' }

  if (leadId != null && leadId !== '') {
    const execId = generateExecutionId()
    const note = await createLeadNote(env, leadId, `[PDF grade curricular] ${fileName} - ${execId}`)
    steps.push({ step: 'note_pdf', ...note })
  }

  return { ok: true, steps, channel: docRes.channel }
}
