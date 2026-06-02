/**
 * Ponte Kommo → n8n quando o poll detecta "Respostas recebidas no Flow".
 * Substitui um Salesbot HTTP no Kommo (a API pública não permite criar salesbots).
 *
 * Env:
 *   N8N_KOMMO_FORM_BRIDGE_ENABLED=true
 *   N8N_KOMMO_FORM_BRIDGE_URL=https://<n8n>/webhook/kommo-form-sum-completed
 *   N8N_KOMMO_FORM_BRIDGE_DEDUPE_SEC=3600 (default)
 */

import { FORM_SUMAR_FLOW_COMPLETED_MARKER } from '../libShared/inscricaoFormHeuristics.js'
import { normalizeTelefone } from './dadosClienteStore.js'

const _dedupeMem = new Map()

function bridgeEnabled(env) {
  const flag = String(env.N8N_KOMMO_FORM_BRIDGE_ENABLED ?? 'true').trim().toLowerCase()
  if (flag === 'false' || flag === '0' || flag === 'no' || flag === 'off') return false
  return Boolean(String(env.N8N_KOMMO_FORM_BRIDGE_URL || '').trim())
}

function dedupeMs(env) {
  const raw = Number(env.N8N_KOMMO_FORM_BRIDGE_DEDUPE_SEC)
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 3600_000
}

function shouldDedupe(env, leadId) {
  const key = String(leadId)
  const prev = _dedupeMem.get(key)
  if (prev && Date.now() - prev < dedupeMs(env)) return true
  _dedupeMem.set(key, Date.now())
  if (_dedupeMem.size > 500) {
    const cutoff = Date.now() - dedupeMs(env)
    for (const [k, t] of _dedupeMem) {
      if (t < cutoff) _dedupeMem.delete(k)
    }
  }
  return false
}

/**
 * @param {Record<string,string>} env
 * @param {{ leadId: number, sessionId?: string, message?: string, source?: string }} ctx
 */
export async function maybeNotifyN8nFormBridge(env, ctx) {
  if (!bridgeEnabled(env)) return { ok: false, skipped: true, reason: 'bridge_disabled' }

  const leadId = Number(ctx.leadId)
  if (!Number.isFinite(leadId) || leadId <= 0) {
    return { ok: false, skipped: true, reason: 'invalid_lead_id' }
  }
  if (shouldDedupe(env, leadId)) {
    return { ok: true, skipped: true, reason: 'dedupe_recent' }
  }

  const url = String(env.N8N_KOMMO_FORM_BRIDGE_URL || '').trim()
  const phone = normalizeTelefone(ctx.sessionId || '')
  const body = {
    lead_id: leadId,
    phone: phone || undefined,
    message: String(ctx.message || FORM_SUMAR_FLOW_COMPLETED_MARKER).trim(),
    source: ctx.source || 'agent_kommo_poll',
    trigger: 'form_flow_completed',
  }

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  const token = String(env.N8N_KOMMO_FORM_BRIDGE_TOKEN || '').trim()
  if (token) headers.Authorization = `Bearer ${token}`

  const timeoutMs = Math.min(Math.max(Number(env.N8N_KOMMO_FORM_BRIDGE_TIMEOUT_MS) || 8000, 2000), 30000)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text().catch(() => '')
    const ok = res.ok
    console.log(
      `[kommo-n8n-bridge] lead=${leadId} POST ${url} ok=${ok} status=${res.status} body=${text.slice(0, 120)}`,
    )
    if (!ok) _dedupeMem.delete(String(leadId))
    return { ok, status: res.status, text: text.slice(0, 300) }
  } catch (err) {
    _dedupeMem.delete(String(leadId))
    console.warn(`[kommo-n8n-bridge] lead=${leadId} falhou: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

/**
 * Empurra marcador de form no buffer e notifica n8n (fire-and-forget no n8n).
 */
export async function handleFormFlowCompletion(env, { leadId, sessionId, rawMessage, source, pushMessageFn }) {
  const flowText = FORM_SUMAR_FLOW_COMPLETED_MARKER
  if (typeof pushMessageFn === 'function') {
    await pushMessageFn(env, sessionId, flowText, { skipDedupe: true })
  }
  return maybeNotifyN8nFormBridge(env, {
    leadId,
    sessionId,
    message: rawMessage || flowText,
    source,
  })
}
