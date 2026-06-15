/**
 * Reativação por inbound.
 *
 * O scheduler só responde leads em `13756724 (Agente-Sumaré) / 106140284
 * (Atendimento)`. Quem manda mensagem estando em OUTRA etapa/pipeline fica
 * "órfão" no buffer e nunca é respondido.
 *
 * Este módulo detecta sessões com mensagem pendente cujo lead está numa etapa
 * elegível (ver DEFAULT_SOURCES) e MOVE o lead para o funil do agente, para o
 * tick seguinte do scheduler responder.
 *
 * Decisão da operação (AGENT.md 2026-06-15 "Reativação por inbound"):
 *   • 13756724/106377088 (Aguardando resposta do agente) → cliente respondeu.
 *   • 13080160 (SUMARÉ-COMERCIAL) nos status ativos → IA assume.
 *   • NUNCA reativa terminais (142/143) nem etapas de inscrição/pagamento.
 *
 * Envs:
 *   LEAD_REACTIVATION_ENABLED=true        liga/desliga (default true)
 *   LEAD_REACTIVATION_CAP=15              máx. reativações por varredura
 *   LEAD_REACTIVATION_SWEEP_SEC=45        intervalo mínimo entre varreduras
 *   LEAD_REACTIVATION_MAX_AGE_HOURS=24    idade máx. da mensagem p/ reativar
 *   LEAD_REACTIVATION_SOURCES=<json>      override das fontes (ver DEFAULT_SOURCES)
 */

import { findLeadByPhone, updateLeadPipelineStatus } from './kommoClient.js'
import {
  getMessages,
  getLastTouchedAt,
  listSessionsWithPendingMessages,
} from './evolution/messageBuffer.js'
import { isSessionParkedForHuman } from './flushRetryBackoff.js'

const AGENT_PIPELINE_ID = 13756724
const AGENT_ATENDIMENTO_STATUS = 106140284

/** Status terminais — venda ganha/perdida. Nunca reativa. */
const TERMINAL_STATUSES = new Set([142, 143])

/**
 * Etapas que, ao receber mensagem nova do cliente, devem ser movidas para o
 * funil do agente. Só status ATIVOS — inscrição/pagamento em andamento e
 * terminais ficam de fora de propósito.
 */
const DEFAULT_SOURCES = [
  // Funil do próprio agente: cliente respondeu enquanto "Aguardando resposta".
  { pipelineId: 13756724, statusIds: [106377088] },
  // SUMARÉ-COMERCIAL (pipeline dos consultores) — status ativos.
  {
    pipelineId: 13080160,
    statusIds: [
      100859828, // Incoming leads
      100859832, // Contato inicial
      100859836, // sem resposta
      106076568, // agente IA
      100859840, // em atendimento
      100860052, // aguardando resposta
      100871908, // robô
    ],
  },
]

function isFalse(v) {
  const f = String(v ?? '').trim().toLowerCase()
  return f === 'false' || f === '0' || f === 'no'
}

export function isReactivationEnabled(env) {
  // default LIGADO; só desliga explicitamente.
  return !isFalse(env.LEAD_REACTIVATION_ENABLED)
}

function getCap(env) {
  const v = Number(env.LEAD_REACTIVATION_CAP)
  return Number.isFinite(v) && v > 0 ? Math.min(50, Math.floor(v)) : 15
}

export function getSweepIntervalMs(env) {
  const v = Number(env.LEAD_REACTIVATION_SWEEP_SEC)
  const sec = Number.isFinite(v) && v > 0 ? Math.floor(v) : 45
  return sec * 1000
}

function getMaxAgeMs(env) {
  const v = Number(env.LEAD_REACTIVATION_MAX_AGE_HOURS)
  const hours = Number.isFinite(v) && v > 0 ? v : 24
  return hours * 3600 * 1000
}

function getSources(env) {
  const raw = String(env.LEAD_REACTIVATION_SOURCES || '').trim()
  if (!raw) return DEFAULT_SOURCES
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length) return parsed
  } catch {
    console.warn('[reactivation] LEAD_REACTIVATION_SOURCES inválido (JSON) — usando default')
  }
  return DEFAULT_SOURCES
}

/**
 * Decide se um lead deve ser reativado (movido p/ o funil do agente).
 * @returns {{ reactivate: boolean, reason?: string, target?: {pipelineId:number, statusId:number} }}
 */
export function shouldReactivate(env, lead) {
  const pid = Number(lead?.pipeline_id)
  const sid = Number(lead?.status_id)
  if (!Number.isFinite(pid) || !Number.isFinite(sid) || pid <= 0 || sid <= 0) {
    return { reactivate: false, reason: 'no_pipeline_status' }
  }
  if (pid === AGENT_PIPELINE_ID && sid === AGENT_ATENDIMENTO_STATUS) {
    return { reactivate: false, reason: 'already_in_funnel' }
  }
  if (TERMINAL_STATUSES.has(sid)) {
    return { reactivate: false, reason: 'terminal_status' }
  }
  const sources = getSources(env)
  const match = sources.find(
    (s) =>
      Number(s.pipelineId) === pid &&
      (s.statusIds || []).map(Number).includes(sid),
  )
  if (!match) return { reactivate: false, reason: `not_in_sources(${pid}/${sid})` }
  return {
    reactivate: true,
    target: { pipelineId: AGENT_PIPELINE_ID, statusId: AGENT_ATENDIMENTO_STATUS },
  }
}

/**
 * Resolve o lead (por telefone se necessário) e move p/ o funil se elegível.
 * @returns {Promise<{action:string, reason?:string, leadId?:number, from?:string, to?:string, error?:string}>}
 */
export async function tryReactivateLead(env, { phone, lead, leadId } = {}) {
  if (!isReactivationEnabled(env)) return { action: 'disabled' }
  let resolved = lead || null
  if (!resolved && phone) {
    const f = await findLeadByPhone(env, phone)
    resolved = f.ok ? f.lead : null
  }
  if (!resolved && leadId) {
    const { getLeadById } = await import('./kommoClient.js')
    const g = await getLeadById(env, leadId)
    resolved = g.ok ? g.lead : null
  }
  if (!resolved) return { action: 'skip', reason: 'lead_not_found' }

  const dec = shouldReactivate(env, resolved)
  if (!dec.reactivate) return { action: 'skip', reason: dec.reason, leadId: Number(resolved.id) }

  const from = `${resolved.pipeline_id}/${resolved.status_id}`
  const mv = await updateLeadPipelineStatus(env, Number(resolved.id), dec.target)
  if (!mv.ok) {
    return { action: 'reactivate_failed', leadId: Number(resolved.id), from, error: mv.error || mv.code }
  }
  return {
    action: 'reactivated',
    leadId: Number(resolved.id),
    from,
    to: `${dec.target.pipelineId}/${dec.target.statusId}`,
  }
}

/**
 * Varredura: sessões com buffer pendente cujo lead está fora do funil e é
 * elegível → move p/ o funil do agente. O tick seguinte responde.
 *
 * @param {Record<string,string>} env
 * @param {{ cap?: number, maxAgeMs?: number, dryRun?: boolean }} [opts]
 */
export async function reactivateOrphanLeads(env, opts = {}) {
  const stats = { scanned: 0, reactivated: 0, skipped: 0, failed: 0 }
  if (!isReactivationEnabled(env)) return stats

  const dryRun = Boolean(opts.dryRun)
  const cap = opts.cap ?? getCap(env)
  const maxAgeMs = opts.maxAgeMs ?? getMaxAgeMs(env)
  const scanCap = Math.min(80, Math.max(cap * 4, 20))

  let sessions = []
  try {
    sessions = await listSessionsWithPendingMessages(env, scanCap)
  } catch (err) {
    console.warn('[reactivation] listSessions falhou:', err.message)
    return stats
  }

  for (const sessionId of sessions) {
    if (stats.reactivated >= cap) break
    try {
      const msgs = await getMessages(env, sessionId)
      if (!msgs || msgs.length === 0) continue
      // Sessão parada para humano por falha de envio (token Meta etc.): não
      // re-puxar enquanto o buffer tiver o MESMO conteúdo não respondido —
      // senão a reativação desfaz a escalação e vira loop. Conteúdo novo do
      // cliente muda o hash e libera a reativação automaticamente.
      if (isSessionParkedForHuman(sessionId, msgs)) {
        stats.skipped += 1
        continue
      }
      const last = await getLastTouchedAt(env, sessionId)
      const age = last ? Date.now() - last.getTime() : Infinity
      if (Number.isFinite(maxAgeMs) && age > maxAgeMs) {
        stats.skipped += 1
        continue
      }
      const phone = String(sessionId).split('@')[0].replace(/[^0-9]/g, '')
      if (!phone) continue
      stats.scanned += 1
      if (dryRun) {
        const f = await findLeadByPhone(env, phone)
        const lead = f.ok ? f.lead : null
        const dec = lead ? shouldReactivate(env, lead) : { reactivate: false, reason: 'lead_not_found' }
        if (dec.reactivate) {
          stats.reactivated += 1
          console.log(
            `[reactivation][dry] WOULD move lead=${lead.id} ${lead.pipeline_id}/${lead.status_id} → ${dec.target.pipelineId}/${dec.target.statusId} (session=${sessionId}, msgs=${msgs.length})`,
          )
        } else {
          stats.skipped += 1
        }
        continue
      }
      const res = await tryReactivateLead(env, { phone })
      if (res.action === 'reactivated') {
        stats.reactivated += 1
        console.log(
          `[reactivation] lead=${res.leadId} ${res.from} → ${res.to} (session=${sessionId}, msgs=${msgs.length})`,
        )
      } else if (res.action === 'reactivate_failed') {
        stats.failed += 1
        console.warn(`[reactivation] falha mover lead=${res.leadId} (${res.from}): ${res.error}`)
      } else {
        stats.skipped += 1
      }
    } catch (err) {
      stats.failed += 1
      console.warn(`[reactivation] erro session=${sessionId}:`, err.message)
    }
  }

  if (stats.reactivated > 0 || stats.failed > 0) {
    console.log(
      `[reactivation] varredura: ${stats.reactivated} reativados, ${stats.skipped} ignorados, ${stats.failed} falhas (de ${sessions.length} sessões)`,
    )
  }
  return stats
}
