/**
 * Watcher de saída do funil — Feedback IA.
 *
 * Estratégia: o `agentScheduler` já lista, a cada tick, os leads
 * presentes no `KOMMO_AGENT_PIPELINE_ID + KOMMO_AGENT_STATUS_ID`.
 * Mantemos em memória um Snapshot do tick anterior. Quando um lead
 * deixa de aparecer (saiu do funil), enfileiramos UMA avaliação.
 *
 * Por que em memória:
 *   - Snapshot é volátil — em caso de restart do servidor, perdemos um
 *     tick mas o próximo poll reidrata. Não precisamos persistir.
 *   - Avaliação propriamente dita já é idempotente (unique
 *     conversation_key na tabela).
 *
 * Fila e dedupe:
 *   - In-memory Set de pending lead ids. Tarefa async drena em série.
 *   - Cap de 8 avaliações por execução pra não estourar quota OpenAI.
 *
 * Liga/desliga via env FEEDBACK_IA_ENABLED (default true em dev se
 * OPENAI_API_KEY estiver presente). Em produção pode-se forçar
 * FEEDBACK_IA_ENABLED=false enquanto a feature ainda está em rampa.
 */

import { evaluateConversation } from './ruleEvaluator.js'

let previousFunnelIds = new Set()
const pendingQueue = new Set()
let draining = false

const DEFAULT_CAP_PER_DRAIN = 8

function isEnabled(env) {
  const flag = String(env.FEEDBACK_IA_ENABLED || '').trim().toLowerCase()
  if (flag === 'false' || flag === '0' || flag === 'no') return false
  if (!env.OPENAI_API_KEY && !env.VITE_OPENAI_API_KEY) return false
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return false
  return true
}

function getCap(env) {
  const v = Number(env.FEEDBACK_IA_DRAIN_CAP)
  return Number.isFinite(v) && v > 0 ? Math.min(40, Math.floor(v)) : DEFAULT_CAP_PER_DRAIN
}

/**
 * Notifica o watcher dos IDs presentes no funil neste tick. Detecta
 * quem saiu e dispara avaliação (não-bloqueante). Idempotente: pode ser
 * chamado várias vezes por tick sem dano (Set de pending dedupa, e a
 * tabela tem unique conversation_key).
 */
export function notifyFunnelSnapshot(env, currentLeadIds) {
  const current = new Set(currentLeadIds.map(Number).filter((n) => Number.isFinite(n)))
  const entered = []
  for (const id of current) {
    if (!previousFunnelIds.has(id)) entered.push(id)
  }
  if (!isEnabled(env)) {
    previousFunnelIds = current
    return { enabled: false, exited: 0, entered }
  }
  const exited = []
  for (const id of previousFunnelIds) {
    if (!current.has(id)) exited.push(id)
  }
  for (const id of exited) pendingQueue.add(id)
  previousFunnelIds = current

  if (exited.length > 0) {
    console.log(`[feedbackIA] funnel-exit detectado: ${exited.length} lead(s) [${exited.slice(0, 10).join(', ')}${exited.length > 10 ? '…' : ''}]`)
    // dispara dreno mas não aguarda
    drainQueue(env).catch((e) => console.error('[feedbackIA] drain error:', e.message))
  }
  if (entered.length > 0) {
    console.log(
      `[scheduler] funnel-reentry: ${entered.length} lead(s) [${entered.slice(0, 10).join(', ')}${entered.length > 10 ? '…' : ''}]`,
    )
  }
  return { enabled: true, exited: exited.length, entered, queued: pendingQueue.size }
}

async function drainQueue(env) {
  if (draining) return
  draining = true
  const cap = getCap(env)
  try {
    let processed = 0
    while (pendingQueue.size > 0 && processed < cap) {
      const leadId = pendingQueue.values().next().value
      pendingQueue.delete(leadId)
      try {
        const r = await evaluateConversation(env, { leadId, trigger: 'funnel_exit' })
        if (r.ok) {
          console.log(`[feedbackIA] lead=${leadId} avaliado verdict=${r.evaluation?.verdict} score=${r.evaluation?.score}`)
        } else if (r.skipped) {
          if (r.skipped !== 'duplicate' && r.skipped !== 'no_executions') {
            console.log(`[feedbackIA] lead=${leadId} skipped=${r.skipped}`)
          }
        } else {
          console.warn(`[feedbackIA] lead=${leadId} falha: ${r.error}`)
        }
      } catch (e) {
        console.error(`[feedbackIA] lead=${leadId} exception:`, e.message)
      }
      processed += 1
    }
    if (pendingQueue.size > 0) {
      console.log(`[feedbackIA] dreno terminou em cap=${cap}, restam ${pendingQueue.size} na fila (próximo tick continua)`)
    }
  } finally {
    draining = false
  }
}

export function getFunnelWatcherState() {
  return {
    enabled: undefined, // preenchido pelo caller que sabe o env
    pendingCount: pendingQueue.size,
    previousFunnelCount: previousFunnelIds.size,
    draining,
  }
}

/** Permite forçar avaliação de um lead via endpoint manual. */
export function enqueueManualEvaluation(leadIds) {
  const list = Array.isArray(leadIds) ? leadIds : [leadIds]
  let added = 0
  for (const raw of list) {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) continue
    if (!pendingQueue.has(n)) {
      pendingQueue.add(n)
      added += 1
    }
  }
  return { added, queueSize: pendingQueue.size }
}
