/**
 * Webhook NATIVO da WhatsApp Cloud API (Meta) — recebe mensagens direto da
 * Meta, sem Evolution no meio.
 *
 * Igual ao webhook Evolution, aqui a gente SÓ BUFFERIZA. Quem decide quando
 * responder é o agentScheduler (loop que lê o funil/status no Kommo e
 * processa o buffer). Assim todo o resto — IA, inscrição, polo, distribuir,
 * envio Cloud API, "digitando..." — continua idêntico ao que já roda hoje.
 *
 * Rotas (registradas no server.js):
 *   GET  /api/whatsapp/webhook  → verificação (hub.challenge) do painel Meta
 *   POST /api/whatsapp/webhook  → eventos (messages / statuses)
 *
 * Segurança:
 *   - GET valida hub.verify_token == WHATSAPP_WEBHOOK_VERIFY_TOKEN
 *   - POST valida assinatura X-Hub-Signature-256 (HMAC-SHA256 com
 *     WHATSAPP_APP_SECRET). Sem app secret configurado, a assinatura não é
 *     exigida (útil em teste), mas recomenda-se configurar em produção.
 *
 * Rollout seguro: enquanto WHATSAPP_WEBHOOK_VERIFY_TOKEN não estiver setado,
 * a rota fica INERTE (GET 403, POST ignora). O webhook Evolution continua
 * funcionando como fallback. Para virar a chave: configure as envs + aponte
 * a Callback URL no painel Meta.
 *
 * Envs:
 *   WHATSAPP_WEBHOOK_VERIFY_TOKEN  (obrigatório p/ ativar) string que você define
 *   WHATSAPP_APP_SECRET            (recomendado) App Secret do app Meta
 *   WHATSAPP_ACCESS_TOKEN          token Meta/WABA (já usado no envio + mídia)
 *   WHATSAPP_API_VERSION           opcional, default v19.0
 *   WHATSAPP_INGEST_PHONE_ALLOWLIST  CSV de telefones permitidos (fase de teste).
 *                                    Fallback: EVOLUTION_INGEST_PHONE_ALLOWLIST.
 *                                    Vazio = aceita qualquer número.
 */

import crypto from 'crypto'
import { pushMessage } from '../evolution/messageBuffer.js'
import { recordSyncOutcome, recordBufferWrite, recordAsyncError } from '../evolution/webhookDiagnostics.js'
import { rememberWamid } from '../evolution/sessionWamid.js'
import { seenMessage } from '../evolution/concurrency.js'
import { transcribeAudioBase64, analyzeImageBase64 } from '../evolution/openaiMedia.js'
import { phoneToWhatsAppSessionId } from '../phoneWhatsApp.js'
import { fetchMetaMediaBase64 } from './metaMedia.js'

function getMetaWebhookConfig(env) {
  return {
    verifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    enabled: Boolean(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN),
  }
}

export function isMetaWebhookEnabled(env) {
  return getMetaWebhookConfig(env).enabled
}

/**
 * Valida X-Hub-Signature-256. Sem app secret configurado, não exige (skipped).
 */
export function verifyMetaSignature(env, rawBody, signatureHeader) {
  const { appSecret } = getMetaWebhookConfig(env)
  if (!appSecret) return { ok: true, skipped: 'no_app_secret' }
  if (!rawBody || !signatureHeader) return { ok: false, reason: 'missing_signature_or_body' }
  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')
  const a = Buffer.from(String(signatureHeader))
  const b = Buffer.from(expected)
  if (a.length !== b.length) return { ok: false, reason: 'length_mismatch' }
  try {
    return { ok: crypto.timingSafeEqual(a, b) }
  } catch {
    return { ok: false, reason: 'compare_error' }
  }
}

function parseIngestAllowlist(env) {
  const raw = String(
    env.WHATSAPP_INGEST_PHONE_ALLOWLIST || env.EVOLUTION_INGEST_PHONE_ALLOWLIST || '',
  ).trim()
  if (!raw) return null
  const set = new Set()
  for (const part of raw.split(/[,\s;]+/)) {
    const d = String(part).replace(/[^0-9]/g, '')
    if (d) set.add(d)
  }
  return set.size > 0 ? set : null
}

function isPhoneAllowed(env, digits) {
  const allow = parseIngestAllowlist(env)
  if (!allow) return true
  if (!digits) return false
  for (const a of allow) {
    if (digits === a || digits.endsWith(a) || a.endsWith(digits)) return true
  }
  return false
}

/**
 * Converte uma mensagem (formato Meta) no texto que vai pro buffer.
 * Os marcadores de áudio/imagem são IDÊNTICOS aos do caminho Evolution
 * para que o prompt (Regra de mídia) reaja da mesma forma.
 */
async function extractTextFromMetaMessage(env, message) {
  const type = message?.type

  switch (type) {
    case 'text':
      return message.text?.body || ''

    case 'button':
      return message.button?.text || message.button?.payload || ''

    case 'interactive': {
      const i = message.interactive || {}
      if (i.button_reply) return i.button_reply.title || i.button_reply.id || ''
      if (i.list_reply) return i.list_reply.title || i.list_reply.id || ''
      if (i.nfm_reply) {
        const raw = i.nfm_reply.response_json || i.nfm_reply.body || null
        if (raw) {
          const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
          return `[FORMULARIO SUMAR]: ${s}`
        }
      }
      return ''
    }

    case 'audio': {
      const id = message.audio?.id
      const dl = id ? await fetchMetaMediaBase64(env, id) : { ok: false }
      if (!dl.ok || !dl.base64) {
        console.error(`[MetaWebhook][audio] download falhou: ${dl.code || 'no_id'} ${dl.error || ''}`)
        return '[ÁUDIO RECEBIDO mas não foi possível baixar o conteúdo. Peça desculpas, resuma o que já foi conversado sobre o curso (se houver no histórico) e peça pro lead reenviar em texto ou gravar de novo. NÃO encaminhe para consultor humano neste turno.]'
      }
      try {
        const txt = await transcribeAudioBase64(env, dl.base64, {
          filename: 'file.ogg',
          mimeType: dl.mimeType || 'audio/ogg',
        })
        if (!txt || !txt.trim()) {
          return '[ÁUDIO RECEBIDO mas a transcrição ficou vazia — confirme com o lead se ele pode reenviar ou digitar a mensagem.]'
        }
        return `[ÁUDIO TRANSCRITO]: ${txt.trim()}`
      } catch (e) {
        console.error('[MetaWebhook][audio] falha na transcrição:', e.message)
        return '[ÁUDIO RECEBIDO mas houve falha técnica na transcrição. Peça para reenviar ou digitar; continue o atendimento sobre o curso em discussão. NÃO encaminhe para consultor humano neste turno.]'
      }
    }

    case 'image': {
      const id = message.image?.id
      const caption = String(message.image?.caption || '').trim()
      const dl = id ? await fetchMetaMediaBase64(env, id) : { ok: false }
      if (!dl.ok || !dl.base64) {
        console.error(`[MetaWebhook][image] download falhou: ${dl.code || 'no_id'} ${dl.error || ''}`)
        return caption
          ? `[IMAGEM RECEBIDA mas o conteúdo não foi processado tecnicamente. Legenda enviada pelo lead: "${caption}". Peça desculpas e diga que vai pedir pra um consultor analisar a imagem.]`
          : '[IMAGEM RECEBIDA mas o conteúdo não foi processado tecnicamente. Peça desculpas e diga que vai pedir pra um consultor analisar a imagem.]'
      }
      try {
        const analysis = await analyzeImageBase64(env, dl.base64, {
          mimeType: dl.mimeType || 'image/jpeg',
        })
        const clean = String(analysis || '').trim()
        if (!clean) {
          return caption
            ? `[IMAGEM RECEBIDA mas a análise visual ficou vazia. Legenda do lead: "${caption}".]`
            : '[IMAGEM RECEBIDA mas a análise visual ficou vazia. Peça ao lead pra reenviar ou descrever em texto.]'
        }
        return caption ? `${clean}\n\n[Legenda do lead na imagem]: ${caption}` : clean
      } catch (e) {
        console.error('[MetaWebhook][image] falha na análise:', e.message)
        return caption
          ? `[IMAGEM RECEBIDA mas houve falha técnica ao analisá-la. Legenda do lead: "${caption}". Diga que vai pedir pra um consultor olhar.]`
          : '[IMAGEM RECEBIDA mas houve falha técnica ao analisá-la. Diga que vai pedir pra um consultor olhar.]'
      }
    }

    case 'document': {
      const fn = message.document?.filename || 'documento'
      const caption = String(message.document?.caption || '').trim()
      return caption
        ? `[DOCUMENTO RECEBIDO: ${fn}]. Legenda do lead: "${caption}". Se precisar do conteúdo, peça pro lead resumir em texto.`
        : `[DOCUMENTO RECEBIDO: ${fn}]. Se precisar do conteúdo, peça pro lead resumir em texto.`
    }

    case 'video': {
      const caption = String(message.video?.caption || '').trim()
      return caption
        ? `[VÍDEO RECEBIDO]. Legenda do lead: "${caption}". Peça pro lead descrever em texto o que precisa.`
        : '[VÍDEO RECEBIDO mas o conteúdo de vídeo não é processado. Peça pro lead descrever em texto o que precisa.]'
    }

    case 'location': {
      const loc = message.location || {}
      const place = loc.name || loc.address || ''
      return `[LOCALIZAÇÃO RECEBIDA]: lat=${loc.latitude ?? '?'}, lng=${loc.longitude ?? '?'}${place ? ` (${place})` : ''}`
    }

    default:
      return ''
  }
}

async function handleOneMetaMessage(env, value, message) {
  const from = String(message?.from || '').replace(/[^0-9]/g, '')
  if (!from) {
    recordAsyncError('meta_msg_no_from', JSON.stringify(message?.type || ''))
    return
  }

  const sessionId = phoneToWhatsAppSessionId(from) || `${from}@s.whatsapp.net`

  if (!isPhoneAllowed(env, from)) {
    console.log(`[MetaWebhook] skip ingest_phone_allowlist session=${sessionId}`)
    recordSyncOutcome({ event: 'meta_webhook', outcome: 'skipped_phone_allowlist', detail: sessionId })
    return
  }

  const wamid = message.id
  if (wamid && seenMessage(wamid)) {
    console.log(`[MetaWebhook] duplicado ignorado (${wamid}) ${sessionId}`)
    recordSyncOutcome({ event: 'meta_webhook', outcome: 'duplicate', detail: String(wamid) })
    return
  }
  if (wamid) rememberWamid(sessionId, wamid)

  const text = await extractTextFromMetaMessage(env, message)
  const clean = String(text || '').trim()
  if (!clean) {
    console.warn(`[MetaWebhook] ${message.type} sem conteúdo utilizável (${sessionId})`)
    recordAsyncError('meta_msg_empty', `${message.type} ${sessionId}`)
    return
  }

  const pushRes = await pushMessage(env, sessionId, clean)
  if (pushRes?.pushed === false) {
    console.log(`[MetaWebhook] buffer skip session=${sessionId} reason=${pushRes.skipped || 'unknown'}`)
    return
  }
  recordBufferWrite(sessionId)
  console.log('[MetaWebhook][buffer]', sessionId, clean.slice(0, 120))
  recordSyncOutcome({ event: 'meta_webhook', outcome: 'buffer_ok', detail: sessionId })
}

/** GET — verificação do painel Meta (hub.challenge). */
export function makeMetaWebhookVerifyHandler(env) {
  return function verify(req, res) {
    const { verifyToken } = getMetaWebhookConfig(env)
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']
    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      console.log('[MetaWebhook] verificação OK — devolvendo challenge')
      res.status(200).send(String(challenge ?? ''))
      return
    }
    console.warn('[MetaWebhook] verificação FALHOU (token divergente ou env ausente)')
    res.status(403).json({ ok: false, error: 'verify token mismatch' })
  }
}

/** POST — eventos de mensagens. Responde 200 rápido e processa em background. */
export function makeMetaWebhookHandler(env) {
  return async function handler(req, res) {
    const cfg = getMetaWebhookConfig(env)

    // Rollout seguro: rota inerte até configurar o verify token.
    if (!cfg.enabled) {
      res.status(200).json({ ok: true, ignored: 'meta_webhook_disabled' })
      return
    }

    const sig = verifyMetaSignature(env, req.rawBody, req.headers['x-hub-signature-256'])
    if (!sig.ok) {
      console.warn(`[MetaWebhook] assinatura inválida (${sig.reason || 'fail'})`)
      recordSyncOutcome({ event: 'meta_webhook', outcome: 'signature_failed', detail: sig.reason || '' })
      res.status(401).json({ ok: false, error: 'invalid signature' })
      return
    }

    const body = req.body || {}
    if (body.object !== 'whatsapp_business_account') {
      res.status(200).json({ ok: true, ignored: 'not_waba' })
      return
    }

    // Meta exige 200 rápido — processamento pesado (mídia/transcrição) async.
    res.status(200).json({ ok: true })

    setImmediate(async () => {
      try {
        for (const entry of body.entry || []) {
          for (const change of entry.changes || []) {
            if (change.field !== 'messages') continue
            const value = change.value || {}
            const messages = value.messages || []
            if (!messages.length) {
              // statuses (sent/delivered/read) — ignoramos.
              continue
            }
            for (const message of messages) {
              try {
                await handleOneMetaMessage(env, value, message)
              } catch (err) {
                recordAsyncError('meta_msg_handler', err.message)
                console.error('[MetaWebhook] erro ao tratar mensagem:', err.message)
              }
            }
          }
        }
      } catch (e) {
        recordAsyncError('meta_webhook', e.message)
        console.error('[MetaWebhook] erro async:', e.message)
      }
    })
  }
}
