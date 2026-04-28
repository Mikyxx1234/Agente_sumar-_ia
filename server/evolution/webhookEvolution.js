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
import { canonicalWhatsAppSessionId } from '../phoneWhatsApp.js'

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
    // Log de entrada — sempre dispara, mesmo nos casos que cairíamos
    // num "skipped". É útil pra diferenciar "Evolution não está nos
    // chamando" de "está chamando mas a gente filtra cedo".
    const evtName = req.body?.event || req.body?.body?.event || 'unknown'
    const fromMe = Boolean(req.body?.data?.key?.fromMe ?? req.body?.body?.data?.key?.fromMe)
    console.log(`[Evolution][hit] event=${evtName} fromMe=${fromMe}`)

    if (!authOk(env, req)) {
      console.warn('[Evolution] auth FAIL — webhook chegou mas X-Webhook-Token/Authorization inválido')
      res.status(401).json({ ok: false, error: 'invalid token' })
      return
    }
    const payload = getBody(req)
    const messageType = getMessageType(payload)
    const sessionRaw = getSessionId(payload)
    const sessionId = resolveBufferSessionId(payload)
    const pushName = getPushName(payload)

    if (!messageType || !sessionId) {
      console.log(`[Evolution] skip missing_type_or_session (event=${evtName}) rawJid=${sessionRaw || 'n/a'}`)
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
      res.status(200).json({ ok: true, skipped: 'fromMe' })
      return
    }

    const messageId = getMessageId(payload)
    if (seenMessage(messageId)) {
      console.log(`[Evolution] duplicado ignorado (${messageId}) ${sessionId}`)
      res.status(200).json({ ok: true, skipped: 'duplicate', messageId })
      return
    }

    // Guarda o wamid (em modo Cloud API). Vai ser usado no flush pra mostrar
    // "digitando..." enquanto a IA processa. Em modo Baileys o id não tem
    // formato wamid e o cache descarta automaticamente.
    rememberWamid(sessionId, messageId)

    res.status(200).json({ ok: true, accepted: true, messageType, sessionId, messageId })

    setImmediate(async () => {
      try {
        const text = await extractMessageText(env, payload, messageType)
        const clean = String(text || '').trim()
        if (!clean) {
          console.warn(`[Evolution] ${messageType} sem conteúdo utilizável (${sessionId})`)
          return
        }
        console.log(`[Evolution] ${messageType} ← ${sessionId} (${pushName}): "${clean.slice(0, 140)}"`)
        await pushMessage(env, sessionId, clean)
        // O scheduler decide quando processar (poll a cada
        // KOMMO_SCHEDULER_INTERVAL_SEC). Aqui não chamamos mais Kommo
        // nem disparamos flush — só bufferizamos.
      } catch (err) {
        console.error('[Evolution] processing error:', err.message)
      }
    })
  }
}
