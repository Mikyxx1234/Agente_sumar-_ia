/**
 * Envio de mensagens pela WhatsApp Cloud API (Meta / WACA).
 * Espelha o fluxo do `envio mensagem.txt` do N8N:
 *
 *   texto da IA → split em partes (≤1000 chars, quebra inteligente)
 *     para cada parte:
 *       • POST /<phone_number_id>/messages (Cloud API)
 *       • POST /api/v4/leads/{id}/notes    (Kommo, com "<texto> - <execution_id>")
 *       • wait 1 segundo
 *
 * Env:
 *   WHATSAPP_OUTBOUND_MODE     opcional: `cloud` (default) | `evolution`
 *                              `evolution` = POST /message/sendText na Evolution
 *                              (mesma instância que recebe); exige EVOLUTION_*.
 *   WHATSAPP_PHONE_NUMBER_ID   ex: 794200977108142 (só modo cloud + typing/read)
 *   WHATSAPP_ACCESS_TOKEN      token do Meta Business (WACA) — não é o apikey da Evolution
 *   WHATSAPP_API_VERSION       opcional, default v19.0
 *   WHATSAPP_MAX_CHARS         opcional, default 1000 (mesmo do n8n)
 *   WHATSAPP_CHUNK_DELAY_MS    opcional, default 1000
 */

import { createLeadNote } from './kommoClient.js'
import { generateExecutionId } from './ai/executionTelemetry.js'
import { sendTextViaEvolution } from './evolution/evolutionSendText.js'
import { shouldSkipDuplicateOutbound, releaseOutboundSync } from './outboundDedupe.js'
import {
  isPostFormOutboundText,
  tryClaimPostFormWhatsappSend,
  leadHasPostFormRegistradoNote,
  releasePostFormSendSync,
} from './postFormSendGuard.js'
import { sanitizeCourseLinksFromReply } from '../libShared/courseLinkOutboundGuard.js'
import {
  isEduitBackend,
  sendEduitOutboundText,
  normalizeCrmLeadId,
} from './crmAdapter.js'

/**
 * Marca a mensagem do cliente como "lida" e mostra o "digitando..." pro
 * cliente, em uma única chamada. É o jeito oficial da Cloud API:
 *
 *   POST /{phone-number-id}/messages
 *   {
 *     messaging_product: "whatsapp",
 *     status: "read",
 *     message_id: "<wamid recebido do cliente>",
 *     typing_indicator: { type: "text" }
 *   }
 *
 * O indicador some sozinho em ~25s ou quando a gente envia a próxima
 * mensagem pro mesmo wpp — o que vier primeiro. Por isso a gente chama
 * isso ANTES do runAgent: enquanto a IA pensa + envia, o cliente vê o
 * "digitando...".
 *
 * @returns { ok, status?, code?, error?, data? }
 */
export async function sendCloudTypingRead(env, { messageId } = {}) {
  const cfg = getConfig(env)
  if (!cfg.phoneNumberId || !cfg.accessToken) {
    return { ok: false, code: 'WHATSAPP_NOT_CONFIGURED', error: 'Configure WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN.' }
  }
  if (!messageId) {
    return { ok: false, code: 'MISSING_MESSAGE_ID', error: 'wamid ausente — Cloud API exige o id da mensagem recebida' }
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      }),
    })
    const raw = await res.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
    if (!res.ok) {
      return { ok: false, status: res.status, code: 'WHATSAPP_TYPING_FAILED', error: typeof raw === 'string' ? raw.slice(0, 400) : '', data }
    }
    return { ok: true, status: res.status, data }
  } catch (e) {
    return { ok: false, code: 'WHATSAPP_FETCH_FAILED', error: e.message }
  }
}

function getConfig(env) {
  const maxChars = Number(env.WHATSAPP_MAX_CHARS)
  const chunkDelay = Number(env.WHATSAPP_CHUNK_DELAY_MS)
  return {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v19.0',
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 1000,
    chunkDelayMs: Number.isFinite(chunkDelay) && chunkDelay >= 0 ? Math.floor(chunkDelay) : 1000,
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

function digitsOnly(input) {
  return String(input || '').split('@')[0].replace(/[^0-9]/g, '')
}

/**
 * Split inteligente — porta do `Code in JavaScript1` do N8N (envio mensagem.txt).
 * Quebra o texto em partes de até `maxLen` chars preferindo separadores naturais.
 */
export function splitMessage(input, maxLen = 1000) {
  const s = String(input || '').trim()
  if (!s) return []
  if (s.length <= maxLen) return [s]

  const chunks = []
  let i = 0

  const pickCut = (window) => {
    const prefer = ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ', ' ']
    for (const sep of prefer) {
      const idx = window.lastIndexOf(sep)
      if (idx >= Math.min(200, Math.floor(maxLen * 0.4))) {
        return idx + (sep.length === 2 ? 1 : 0)
      }
    }
    const lastSpace = window.lastIndexOf(' ')
    if (lastSpace > 20) return lastSpace
    return window.length
  }

  while (i < s.length) {
    if (s.length - i <= maxLen) {
      chunks.push(s.slice(i).trim())
      break
    }
    const window = s.slice(i, i + maxLen)
    let cut = pickCut(window)
    let piece = window.slice(0, cut).trim()
    if (!piece) {
      piece = window.slice(0, maxLen).trim()
      cut = maxLen
    }
    chunks.push(piece)
    i += cut
    while (s[i] === ' ' || s[i] === '\n') i++
  }
  return chunks.filter(Boolean)
}

/**
 * Envia UM pedaço via WhatsApp Cloud API.
 * @returns { ok, status?, messageId?, code?, error? }
 */
export async function sendText(env, { to, text, conversationId } = {}) {
  // CRM EduIT: único caminho de outbound — POST conversa (sem Cloud API / Evolution).
  if (isEduitBackend(env)) {
    const recipient = digitsOnly(to)
    if (!recipient) return { ok: false, code: 'MISSING_TO', error: 'destinatário vazio' }
    const body = String(text || '')
    if (!body.trim()) return { ok: false, code: 'EMPTY_BODY', error: 'texto vazio' }
    const sent = await sendEduitOutboundText(env, {
      telefone: recipient,
      text: body,
      conversationId,
    })
    if (!sent.ok) {
      return {
        ok: false,
        code: sent.code || 'EDUIT_SEND_FAILED',
        status: sent.status,
        error: sent.error || 'falha envio EduIT',
      }
    }
    return {
      ok: true,
      status: sent.status,
      messageId: sent.messageId || null,
      via: 'eduit',
    }
  }

  const outbound = String(env.WHATSAPP_OUTBOUND_MODE || 'cloud').toLowerCase().trim()
  if (outbound === 'evolution') {
    return sendTextViaEvolution(env, { to, text })
  }

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
  const body = String(text || '')
  if (!body.trim()) return { ok: false, code: 'EMPTY_BODY', error: 'texto vazio' }

  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`
  try {
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
        type: 'text',
        text: { body, preview_url: /https?:\/\//i.test(body) },
      }),
    })
    const raw = await res.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
    if (!res.ok) {
      return {
        ok: false,
        code: 'WHATSAPP_SEND_FAILED',
        status: res.status,
        error: typeof raw === 'string' ? raw.slice(0, 500) : 'unknown',
      }
    }
    const messageId = data?.messages?.[0]?.id || null
    return { ok: true, status: res.status, messageId }
  } catch (e) {
    return { ok: false, code: 'WHATSAPP_FETCH_FAILED', error: e.message }
  }
}

/**
 * Orquestra split → envio → nota Kommo → espera por cada parte.
 *
 * @param {Record<string,string>} env
 * @param {object} params
 * @param {string} params.telefone      destinatário (aceita JID ou só dígitos)
 * @param {string} params.text          resposta completa da IA (será split)
 * @param {number|string} [params.leadId] id do lead Kommo ou deal CUID EduIT
 * @param {string} [params.executionId] id único de execução; gerado se não informado
 * @param {string} [params.conversationId] conversa EduIT (só CRM_BACKEND=eduit)
 * @returns { ok, executionId, total, sent, steps[], error? }
 */
export async function sendMessageWithNote(env, {
  telefone,
  text,
  leadId,
  executionId,
  freshUserTurn = false,
  conversationId,
} = {}) {
  const cfg = getConfig(env)
  const linkSan = sanitizeCourseLinksFromReply(text)
  if (linkSan.removed > 0) {
    console.warn(
      `[WhatsApp] course_link_stripped to=${String(telefone || '').slice(0, 20)} removed=${linkSan.removed}`,
    )
    text = linkSan.text
  }
  const parts = splitMessage(text, cfg.maxChars)
  if (!parts.length) {
    return { ok: false, code: 'EMPTY_BODY', error: 'texto vazio', total: 0, sent: 0, steps: [] }
  }
  let holdPostFormSync = false
  try {
    if (isPostFormOutboundText(text)) {
      if (leadId != null && leadId !== '' && (await leadHasPostFormRegistradoNote(env, leadId))) {
        console.log(
          `[WhatsApp] post_form_reply_blocked to=${String(telefone || '').slice(0, 20)} lead=${leadId} reason=kommo_note_already_exists`,
        )
        return {
          ok: true,
          skipped: true,
          deduped: true,
          reason: 'kommo_note_already_exists',
          total: parts.length,
          sent: 0,
          steps: [{ step: 'post_form_guard', skipped: true, reason: 'kommo_note_already_exists' }],
        }
      }
      const postGate = await tryClaimPostFormWhatsappSend(env, telefone, { holdSyncLock: true })
      if (!postGate.allow) {
        console.log(
          `[WhatsApp] post_form_reply_blocked to=${String(telefone || '').slice(0, 20)} reason=${postGate.reason}`,
        )
        return {
          ok: true,
          skipped: true,
          deduped: true,
          reason: postGate.reason,
          total: parts.length,
          sent: 0,
          steps: [{ step: 'post_form_guard', skipped: true, reason: postGate.reason }],
        }
      }
      holdPostFormSync = true
    }

    const dedupe = await shouldSkipDuplicateOutbound(env, telefone, text, { leadId, freshUserTurn })
    if (dedupe.skip) {
      // Race do lock in-memory (tryReserveOutboundSync falhou) NÃO é
      // dedupe: a mensagem precisa ir. Retornamos ok:false para o caller
      // (webhookEvolution.js) tratar como erro e não marcar cooldown nem
      // gravar o hash do buffer — o próximo tick do scheduler reprocessa.
      if (dedupe.race) {
        console.warn(
          `[WhatsApp] outbound race to=${String(telefone || '').slice(0, 20)} reason=${dedupe.reason}`,
        )
        return {
          ok: false,
          race: true,
          code: 'OUTBOUND_INFLIGHT_RACE',
          reason: dedupe.reason,
          error: `Envio bloqueado por race (${dedupe.reason})`,
          total: parts.length,
          sent: 0,
          steps: [{ step: 'dedupe', race: true, reason: dedupe.reason }],
        }
      }
      console.log(
        `[WhatsApp] outbound dedupe skip to=${String(telefone || '').slice(0, 20)} reason=${dedupe.reason}`,
      )
      return {
        ok: true,
        skipped: true,
        deduped: true,
        reason: dedupe.reason,
        total: parts.length,
        sent: 0,
        steps: [{ step: 'dedupe', skipped: true, reason: dedupe.reason }],
      }
    }
    const execId = executionId || generateExecutionId()
    const steps = []

    const crmLeadId = normalizeCrmLeadId(leadId, env)
    const useEduit = isEduitBackend(env)

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const sent = await sendText(env, {
        to: telefone,
        text: part,
        conversationId: useEduit ? conversationId : undefined,
      })
      steps.push({ step: 'send', index: i + 1, total: parts.length, ...sent })
      if (!sent.ok) {
        return {
          ok: false,
          executionId: execId,
          sent: i,
          total: parts.length,
          steps,
          error: sent.error || sent.code,
        }
      }

      // EduIT: a conversa já registra o outbound — não criar nota no deal (duplica UI).
      // Kommo: mantém POST /leads/{id}/notes por parte (comportamento atual).
      if (useEduit) {
        steps.push({ step: 'note', index: i + 1, skipped: true, reason: 'eduit_conversation_only' })
      } else if (crmLeadId != null && crmLeadId !== '') {
        const note = await createLeadNote(env, crmLeadId, `${part} - ${execId}`)
        steps.push({ step: 'note', index: i + 1, total: parts.length, ...note })
        if (!note.ok) {
          console.warn(`[WhatsApp][kommo-note] falha parte ${i + 1}: ${note.error || note.status}`)
        }
      } else {
        steps.push({ step: 'note', index: i + 1, skipped: true, reason: 'no_lead_id' })
      }

      if (i < parts.length - 1 && cfg.chunkDelayMs > 0) {
        await sleep(cfg.chunkDelayMs)
      }
    }

    return { ok: true, executionId: execId, total: parts.length, sent: parts.length, steps }
  } finally {
    if (holdPostFormSync) releasePostFormSendSync(telefone)
    releaseOutboundSync(telefone)
  }
}
