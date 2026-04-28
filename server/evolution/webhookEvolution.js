/**
 * Webhook Evolution API — só BUFFERIZA mensagens.
 *
 * Quem decide se / quando responder é o agentScheduler, que roda em loop
 * (default 30s) listando os leads no funil/status configurados e
 * processando o buffer dos que estão dentro.
 *
 * Aqui a gente:
 *   1) Classifica messageType.
 *   2) Dedup por message.key.id (TTL em memória).
 *   3) Áudio  → transcrição (Whisper).
 *      Imagem → análise (gpt-4o-mini Vision). Botão → texto do botão.
 *   4) Lembra o wamid (Cloud API) pra o "digitando..." conseguir usar.
 *   5) Empurra no buffer (TTL automático no Redis).
 *
 * NÃO chama Kommo, NÃO dispara IA, NÃO agenda flush. Tudo isso é
 * responsabilidade do agentScheduler.
 *
 * Mantemos `flushSession` exportado pq o playground (área de teste) usa
 * o fluxo direto sem passar pelo scheduler.
 */

import { pushMessage, getMessages, clearMessages } from './messageBuffer.js'
import { transcribeAudioBase64, analyzeImageBase64 } from './openaiMedia.js'
import { runAgent } from '../ai/agentRunner.js'
import { saveConversation } from '../historyStore.js'
import { getLeadIdByTelefone } from '../dadosClienteStore.js'
import { seenMessage, withSessionLock } from './concurrency.js'
import { findLeadByPhone } from '../kommoClient.js'
import { sendMessageWithNote } from '../whatsappSender.js'
import { generateExecutionId, saveExecution } from '../ai/executionTelemetry.js'
import { fireTyping } from './typingIndicator.js'
import { rememberWamid, getWamids } from './sessionWamid.js'
import { startTypingHeartbeat } from '../whatsappTypingHeartbeat.js'
import { canonicalWhatsAppSessionId, phoneToWhatsAppSessionId } from '../phoneWhatsApp.js'
import { enqueueCloudInboundPending, matchContactToPending, markCloudBridgeExpectsContact, shouldBufferOrphanContact, clearCloudBridgeContactWindow, bufferOrphanContact } from './cloudInboundPending.js'
import { recordSyncOutcome, recordBufferWrite, recordAsyncError } from './webhookDiagnostics.js'

function getBody(req) {
  const body = req.body || {}
  return body.body ? body.body : body
}

function getMessageType(payload) {
  return (
    payload?.data?.messageType ||
    payload?.messageType ||
    null
  )
}

function getSessionId(payload) {
  const d = payload?.data || payload
  return (
    d?.key?.remoteJid ||
    d?.remoteJid ||
    d?.sessionId ||
    null
  )
}

/**
 * JID usado no buffer = sempre que possível o número em @s.whatsapp.net.
 * Ordem: remoteJidAlt (telefone real quando remoteJid veio como @lid), depois remoteJid.
 */
function resolveBufferSessionId(payload) {
  const d = payload?.data || payload
  const key = d?.key || {}
  const candidates = [
    key.remoteJidAlt,
    key.remote_jid_alt,
    d.remoteJidAlt,
    d.remote_jid_alt,
    key.participant,
    d.participant,
    key.remoteJid,
    d.remoteJid,
    d.sessionId,
  ].filter((x) => typeof x === 'string' && x.length > 0)

  for (const jid of candidates) {
    const c = canonicalWhatsAppSessionId(jid)
    if (c && c.endsWith('@s.whatsapp.net')) return c
  }
  for (const jid of candidates) {
    const c = canonicalWhatsAppSessionId(jid)
    if (c) return c
  }
  return null
}

/** Meta Cloud via Evolution: remoteJid do cliente não vem no messages.upsert — usa ponte contacts.* */
function isCloudBusinessInbound(env, payload, rawBody) {
  const d = payload?.data || payload
  // Só tratar como "saída" se fromMe for explicitamente true. Se vier undefined,
  // algumas versões da Evolution omitem o campo e a mensagem seria bufferizada no JID do negócio.
  if (d?.key?.fromMe === true) return false
  const keyJid = canonicalWhatsAppSessionId(d?.key?.remoteJid)
  if (!keyJid) return false
  const senderJid = canonicalWhatsAppSessionId(rawBody?.sender)
  if (senderJid && keyJid === senderJid) return true
  const cfg = String(env.WHATSAPP_BUSINESS_JID || env.EVOLUTION_CLOUD_BUSINESS_JID || '').trim()
  if (cfg) {
    const c = canonicalWhatsAppSessionId(cfg)
    if (c && keyJid === c) return true
  }
  return false
}

/** Já temos @s.whatsapp.net do lead (participant/remoteJidAlt) → não enfileirar ponte Cloud. */
function clientSessionAlreadyResolved(sessionId, payload) {
  const d = payload?.data || payload
  const remoteKeyJid = canonicalWhatsAppSessionId(d?.key?.remoteJid)
  return Boolean(
    sessionId &&
      remoteKeyJid &&
      sessionId !== remoteKeyJid &&
      sessionId.endsWith('@s.whatsapp.net'),
  )
}

function inferMessageType(payload) {
  const t = getMessageType(payload)
  if (t) return t
  const d = payload?.data || payload
  const m = d?.message || {}
  if (m.conversation) return 'conversation'
  if (m.extendedTextMessage) return 'extendedTextMessage'
  if (m.imageMessage) return 'imageMessage'
  if (m.videoMessage) return 'videoMessage'
  if (m.audioMessage) return 'audioMessage'
  if (m.documentMessage) return 'documentMessage'
  if (m.stickerMessage) return 'stickerMessage'
  if (m.buttonsResponseMessage || m.templateButtonReplyMessage || m.listResponseMessage) {
    return 'buttonsResponseMessage'
  }
  if (m.buttonMessage) return 'buttonMessage'
  if (m.interactiveMessage) return 'interactiveMessage'
  if (m.locationMessage) return 'locationMessage'
  if (m.contactMessage || m.contactsArrayMessage) return 'contactMessage'
  if (m.reactionMessage) return 'reactionMessage'
  return null
}

function normalizeContactPhoneToSessionId(phone) {
  if (phone == null) return null
  const s = String(phone).trim()
  if (!s) return null
  if (s.includes('@')) return canonicalWhatsAppSessionId(s)
  return phoneToWhatsAppSessionId(s)
}

function normalizeTelefone(sessionId) {
  if (!sessionId) return ''
  return String(sessionId).split('@')[0].replace(/[^0-9]/g, '')
}

function getPushName(payload) {
  const d = payload?.data || payload
  return d?.pushName || d?.pushname || ''
}

function getMessageId(payload) {
  const d = payload?.data || payload
  return d?.key?.id || d?.messageId || d?.id || null
}

function getBase64(payload) {
  const d = payload?.data || payload
  return d?.message?.base64 || d?.message?.mediaBase64 || null
}

function getImageCaption(payload) {
  const d = payload?.data || payload
  return d?.message?.imageMessage?.caption || ''
}

function getTextContent(payload) {
  const d = payload?.data || payload
  const m = d?.message || {}
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.buttonText ||
    ''
  )
}

function authOk(env, req) {
  const expected = env.EVOLUTION_WEBHOOK_TOKEN
  if (!expected) return true
  const provided =
    req.headers['x-webhook-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query?.token
  return provided === expected
}

async function extractMessageText(env, payload, messageType) {
  switch (messageType) {
    case 'conversation':
    case 'extendedTextMessage':
      return getTextContent(payload)

    case 'buttonMessage':
    case 'buttonsResponseMessage':
    case 'templateButtonReplyMessage':
    case 'listResponseMessage':
      return getTextContent(payload)

    case 'audioMessage': {
      const b64 = getBase64(payload)
      if (!b64) return ''
      return transcribeAudioBase64(env, b64, { filename: 'file.ogg', mimeType: 'audio/ogg' })
    }

    case 'imageMessage': {
      const b64 = getBase64(payload)
      if (!b64) return ''
      const caption = getImageCaption(payload).trim()
      const analysis = await analyzeImageBase64(env, b64, { mimeType: 'image/png' })
      const clean = analysis.replace(/\n/g, ' ').replace(/['"]/g, '').trim()
      return caption ? `${caption}, ${clean}` : clean
    }

    default:
      return getTextContent(payload)
  }
}

async function flushSessionInner(env, sessionId, opts = {}) {
  const itens = await getMessages(env, sessionId)
  if (!itens.length) {
    console.log(`[Evolution][flush] ${sessionId} sem mensagens pendentes`)
    return null
  }
  await clearMessages(env, sessionId)
  const mensagemCompleta = itens.join(', ')
  const telefone = normalizeTelefone(sessionId)
  const executionId = opts.executionId || generateExecutionId()
  const startedAt = new Date().toISOString()
  const leadIdHint = opts.leadIdHint != null ? Number(opts.leadIdHint) : null
  console.log(`[${executionId}] flush ${sessionId} → "${mensagemCompleta}"`)

  // "Digitando..." começa AQUI, depois do debounce. Caminho preferido =
  // Cloud API (read receipt + typing_indicator) com heartbeat: a gente
  // pinga read+typing a cada ~4s ciclando entre os wamids recentes da
  // sessão pra manter a animação visível enquanto a IA processa. Quando
  // o sendMessageWithNote começa, paramos o heartbeat.
  // Fallback = Evolution presence (só funciona em instâncias Baileys).
  const wamids = getWamids(sessionId)
  let typingHb = null
  if (wamids.length > 0) {
    typingHb = startTypingHeartbeat(env, wamids, {
      intervalMs: 4000,
      maxDurationMs: 90000,
      log: (line) => console.log(`[${executionId}] ${line}`),
    })
  } else {
    fireTyping(env, { jid: sessionId, delayMs: 8000 }, executionId)
  }

  let out = null
  let idLead = null
  let sendResult = null
  let histResult = null
  try {
    out = await runAgent(env, { telefone, userMessage: mensagemCompleta, executionId })
    if (out.ok) {
      console.log(
        `[${executionId}] agent ok (${out.durationMs}ms, ${out.usage?.total_tokens} tok, tools=${out.toolCalls?.length || 0}): ${out.reply?.slice(0, 200)}`,
      )
    } else {
      console.error(`[${executionId}] agent erro:`, out.error)
    }

    if (out?.ok && out.reply) {
      // 1ª prioridade: leadId vindo do scheduler (já achou no Kommo p/
      // listar quem tá no funil). Evita chamar findLeadByPhone de novo.
      if (Number.isFinite(leadIdHint) && leadIdHint > 0) {
        idLead = leadIdHint
        console.log(`[${executionId}] kommo lead ${idLead} (hint do scheduler) p/ ${telefone}`)
      } else {
        try {
          const lookup = await findLeadByPhone(env, telefone)
          if (lookup.ok && lookup.lead) {
            idLead = lookup.lead.id
            console.log(`[${executionId}] kommo lead ${idLead} encontrado p/ ${telefone}`)
          } else if (!lookup.ok) {
            console.warn(`[${executionId}] kommo falha: ${lookup.error || lookup.status}`)
          } else {
            console.log(`[${executionId}] kommo nenhum lead p/ ${telefone}`)
          }
        } catch (err) {
          console.error(`[${executionId}] kommo exception:`, err.message)
        }
      }
      if (idLead == null) {
        try { idLead = await getLeadIdByTelefone(env, telefone) } catch {}
      }

      // Para o "digitando..." imediatamente antes do envio: o próprio envio
      // dispensaria, mas parar antes evita pings desnecessários e race
      // entre typing e a entrega da primeira parte.
      if (typingHb) {
        try { await typingHb.stop() } catch {}
        typingHb = null
      }

      try {
        sendResult = await sendMessageWithNote(env, {
          telefone,
          text: out.reply,
          leadId: idLead,
          executionId,
        })
        if (sendResult.ok) {
          console.log(`[${executionId}] whatsapp enviado ${sendResult.sent}/${sendResult.total} partes`)
        } else {
          console.error(`[${executionId}] whatsapp falha após ${sendResult.sent}/${sendResult.total}:`, sendResult.error)
        }
      } catch (err) {
        console.error(`[${executionId}] whatsapp exception:`, err.message)
      }

      try {
        histResult = await saveConversation(env, {
          telefone,
          userMessage: mensagemCompleta,
          botMessage: out.reply,
          messageType: 'conversation',
          idLead,
        })
        if (!histResult.ok) {
          const failed = histResult.steps.filter((s) => s.ok === false)
          console.warn(`[${executionId}] history falhas:`, JSON.stringify(failed))
        }
      } catch (err) {
        console.error(`[${executionId}] history exception:`, err.message)
      }
    }
  } catch (err) {
    console.error(`[${executionId}] agent exception:`, err.message)
  } finally {
    if (typingHb) {
      try { await typingHb.stop() } catch {}
      typingHb = null
    }
  }

  saveExecution(env, {
    id: executionId,
    timestamp: startedAt,
    userMessage: mensagemCompleta,
    model: out?.model || null,
    steps: buildSteps({ sendResult, histResult, idLead }),
    toolCalls: out?.toolCalls || [],
    response: out?.ok ? out.reply : null,
    error: out?.ok ? null : out?.error || 'runAgent retornou null',
    totalDurationMs: out?.durationMs || 0,
    usage: out?.usage || {},
    telefone,
    leadId: idLead,
    origem: 'evolution',
  }).then((r) => {
    if (!r.ok) console.warn(`[${executionId}] saveExecution falhou: ${r.error}`)
  }).catch((err) => console.error(`[${executionId}] saveExecution exception:`, err.message))

  return out
}

/**
 * Converte o resultado de envio/histórico em "steps" (mesmo conceito do
 * executionStore/ExecutionViewer) para debugar rapidamente o que aconteceu
 * depois que o agente respondeu.
 */
function buildSteps({ sendResult, histResult, idLead }) {
  const steps = []
  if (idLead != null) steps.push({ tool: 'kommo.findLeadByPhone', result: { leadId: idLead } })
  if (sendResult) {
    steps.push({
      tool: 'whatsapp.sendMessageWithNote',
      result: {
        ok: sendResult.ok,
        sent: sendResult.sent,
        total: sendResult.total,
        error: sendResult.error || null,
      },
    })
  }
  if (histResult) {
    const failed = (histResult.steps || []).filter((s) => s.ok === false).map((s) => s.step || 'step')
    steps.push({
      tool: 'history.saveConversation',
      result: {
        ok: histResult.ok,
        failedSubsteps: failed,
      },
    })
  }
  return steps
}

export function flushSession(env, sessionId, opts = {}) {
  return withSessionLock(sessionId, () => flushSessionInner(env, sessionId, opts))
}

export function makeEvolutionWebhookHandler(env) {
  return async function handler(req, res) {
    const rawBody = req.body || {}
    const evtName = rawBody.event || rawBody.body?.event || 'unknown'
    const fromMe = Boolean(rawBody?.data?.key?.fromMe ?? rawBody?.body?.data?.key?.fromMe)
    const instanceName = rawBody.instance != null ? String(rawBody.instance) : null
    const sync = (outcome, detail = null) =>
      recordSyncOutcome({ event: evtName, instance: instanceName, outcome, detail })
    console.log(`[Evolution][hit] event=${evtName} fromMe=${fromMe} instance=${instanceName || 'n/a'}`)

    if (!authOk(env, req)) {
      console.warn('[Evolution] auth FAIL — webhook chegou mas X-Webhook-Token/Authorization inválido')
      sync('auth_failed', 'X-Webhook-Token ou Bearer inválido versus EVOLUTION_WEBHOOK_TOKEN')
      res.status(401).json({ ok: false, error: 'invalid token' })
      return
    }

    // WhatsApp Business (Meta): telefone do lead vem em contacts.* depois do messages.upsert
    if (evtName === 'contacts.upsert' || evtName === 'contacts.update') {
      const data = rawBody.data || rawBody.body?.data || {}
      const instance = rawBody.instance
      const customerSession = normalizeContactPhoneToSessionId(data.remoteJid)
      if (!customerSession) {
        console.log(`[Evolution][contact] skip sem remoteJid instance=${instance}`)
        sync('contact_skip_no_remote_jid', `instance=${instance || 'n/a'}`)
        res.status(200).json({ ok: true, skipped: 'contact_no_phone' })
        return
      }
      const matched = matchContactToPending(instance, customerSession)
      if (!matched) {
        if (shouldBufferOrphanContact(instance)) {
          bufferOrphanContact(instance, customerSession)
          console.log(`[Evolution][contact] contato órfão (Cloud) ${customerSession} instance=${instance}`)
          sync('contact_orphan_in_window', customerSession)
        } else {
          console.log(
            `[Evolution][contact] ${evtName} ignorado (sem fila Cloud) instance=${instance}`,
          )
          sync(
            'contact_no_pending_cloud_queue',
            `${customerSession} — ligue CONTACTS_UPSERT/UPDATE e envie msg de novo, ou veja se messages.upsert Cloud foi antes`,
          )
        }
        res.status(200).json({ ok: true, queued: 'contact_no_pending' })
        return
      }
      try {
        const { pending, sessionId } = matched
        const text = await extractMessageText(env, pending.payload, pending.messageType)
        const clean = String(text || '').trim()
        if (!clean) {
          console.warn(`[Evolution][contact] extract vazio session=${sessionId} type=${pending.messageType}`)
          sync('contact_extract_empty', `${sessionId} type=${pending.messageType}`)
        } else {
          if (pending.messageId) rememberWamid(sessionId, pending.messageId)
          await pushMessage(env, sessionId, clean)
          recordBufferWrite(sessionId)
          clearCloudBridgeContactWindow(instance)
          console.log('[Evolution][cloud] buffer', sessionId, String(clean).slice(0, 120), evtName)
          sync('contact_matched_buffer_ok', sessionId)
        }
      } catch (err) {
        console.error('[Evolution][contact] erro ao bufferizar:', err.message)
        sync('contact_buffer_exception', err.message)
      }
      res.status(200).json({ ok: true, buffered: true })
      return
    }

    if (evtName !== 'messages.upsert') {
      sync('ignored_event', evtName)
      res.status(200).json({ ok: true, ignored: evtName })
      return
    }

    const payload = getBody(req)
    const messageType = inferMessageType(payload)
    const sessionRaw = getSessionId(payload)
    const sessionId = resolveBufferSessionId(payload)
    const pushName = getPushName(payload)

    if (!messageType || !sessionId) {
      console.log(`[Evolution] skip missing_type_or_session (event=${evtName}) rawJid=${sessionRaw || 'n/a'}`)
      sync('msg_missing_type_or_session', `type=${messageType || ''} sessionId=${sessionId || ''} rawJid=${sessionRaw || 'n/a'}`)
      res.status(200).json({ ok: true, skipped: 'missing_type_or_session' })
      return
    }
    if (sessionRaw && sessionRaw !== sessionId) {
      console.log(`[Evolution] jid buffer ${sessionRaw} → ${sessionId}`)
    }
    if (sessionId.endsWith('@lid')) {
      console.warn(
        `[Evolution] remoteJid caiu em @lid sem telefone resolvido — o scheduler (Kommo) não achará o buffer. Verifique Evolution/remoteJidAlt ou atualize a API.`,
      )
    }
    if (payload?.data?.key?.fromMe) {
      console.log(`[Evolution] skip fromMe ${sessionId}`)
      sync('msg_skipped_from_me', sessionId)
      res.status(200).json({ ok: true, skipped: 'fromMe' })
      return
    }

    const messageId = getMessageId(payload)
    if (seenMessage(messageId)) {
      console.log(`[Evolution] duplicado ignorado (${messageId}) ${sessionId}`)
      sync('msg_duplicate', String(messageId))
      res.status(200).json({ ok: true, skipped: 'duplicate', messageId })
      return
    }

    const instance = rawBody.instance

    if (isCloudBusinessInbound(env, payload, rawBody) && !clientSessionAlreadyResolved(sessionId, payload)) {
      console.log(
        `[Evolution][cloud] messages.upsert com JID do negócio — aguardando contacts.* p/ gravar no ${instance || '?'}`,
      )
      sync(
        'cloud_bridge_queued_await_contact',
        `Próximo passo: webhook deve receber contacts.upsert/update com remoteJid do lead. instance=${instance || 'n/a'}`,
      )
      res.status(200).json({ ok: true, accepted: true, cloudBridge: true, messageType, messageId })
      markCloudBridgeExpectsContact(instance)
      const hit = enqueueCloudInboundPending(instance, { messageId, messageType, payload })
      if (hit?.mode === 'immediate') {
        setImmediate(async () => {
          try {
            const text = await extractMessageText(env, payload, messageType)
            const clean = String(text || '').trim()
            if (!clean) {
              console.warn(`[Evolution][cloud] sem conteúdo (immediate) ${hit.sessionId}`)
              recordAsyncError('cloud_immediate_empty', hit.sessionId)
              return
            }
            if (messageId) rememberWamid(hit.sessionId, messageId)
            await pushMessage(env, hit.sessionId, clean)
            recordBufferWrite(hit.sessionId)
            console.log('[Evolution][cloud] buffer orphan resolved', hit.sessionId, String(clean).slice(0, 120))
            clearCloudBridgeContactWindow(instance)
          } catch (err) {
            recordAsyncError('cloud_immediate', err.message)
            console.error('[Evolution][cloud] processing error:', err.message)
          }
        })
      }
      return
    }

    if (isCloudBusinessInbound(env, payload, rawBody) && clientSessionAlreadyResolved(sessionId, payload)) {
      console.log(
        `[Evolution][cloud] bridge ignorada — cliente resolvido no payload (${sessionRaw || 'n/a'} → ${sessionId})`,
      )
    }

    if (messageId) rememberWamid(sessionId, messageId)
    sync('msg_buffer_async_scheduled', `vai gravar em ${sessionId} após extrair texto`)
    res.status(200).json({ ok: true, accepted: true, messageType, sessionId, messageId })

    setImmediate(async () => {
      try {
        const text = await extractMessageText(env, payload, messageType)
        const clean = String(text || '').trim()
        if (!clean) {
          console.warn(`[Evolution] ${messageType} sem conteúdo utilizável (${sessionId})`)
          recordAsyncError('msg_async_empty', `${messageType} ${sessionId}`)
          return
        }
        console.log(`[Evolution] ${messageType} ← ${sessionId} (${pushName}): "${clean.slice(0, 140)}"`)
        await pushMessage(env, sessionId, clean)
        recordBufferWrite(sessionId)
      } catch (err) {
        recordAsyncError('msg_async_buffer', err.message)
        console.error('[Evolution] processing error:', err.message)
      }
    })
  }
}
