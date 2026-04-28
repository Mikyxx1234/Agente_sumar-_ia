/**
 * Agent Scheduler — substitui o gate por-mensagem.
 *
 * Em vez de checar Kommo a cada mensagem que chega no webhook (caro e
 * sensível ao delay do Kommo pra movimentar leads de fase), a gente roda
 * um loop a cada KOMMO_SCHEDULER_INTERVAL_SEC segundos:
 *
 *   1. Lista leads no pipeline + status configurados (1 chamada paginada).
 *   2. Bulk-fetch dos contatos pra extrair telefone (1 chamada).
 *   3. Pra cada lead nesse funil:
 *        - lê o buffer de mensagens dessa sessão.
 *        - se tem mensagem E última mensagem é mais antiga que o debounce
 *          (KOMMO_SCHEDULER_DEBOUNCE_SEC), processa via flushSession passando
 *          o leadId já conhecido (evita re-chamar findLeadByPhone).
 *
 * Vantagens:
 *   • 1 call no Kommo a cada 30s, não importa quantas mensagens cheguem.
 *   • Tolerante a delay: se o lead foi movido pro funil DEPOIS de mandar
 *     mensagem, próximo tick pega ele com a mensagem ainda no buffer.
 *   • Mensagens de leads que nunca entram no funil expiram via TTL do Redis
 *     (default 10 min, MESSAGE_BUFFER_TTL_SEC).
 *
 * Envs:
 *   KOMMO_AGENT_PIPELINE_ID            (obrig.) ex: 11685120
 *   KOMMO_AGENT_STATUS_ID              (obrig.) ex: 89820300
 *   KOMMO_SCHEDULER_INTERVAL_SEC=30    intervalo entre ticks
 *   KOMMO_SCHEDULER_DEBOUNCE_SEC=15    silêncio mínimo após última mensagem
 *   KOMMO_SCHEDULER_ENABLED=true       chave geral pra ligar/desligar
 *   KOMMO_AGENT_TEST_LEAD_IDS          (opcional) lista CSV de lead ids p/
 *                                      whitelist em modo teste. Se setado,
 *                                      a IA SÓ responde leads desta lista
 *                                      (e que estejam no funil acima).
 *                                      Ex.: "19884275" ou "19884275,12345".
 */

import { listLeadsByStatus, bulkGetContactsByIds, extractContactPhone } from './kommoClient.js'
import { getMessages, getLastTouchedAt } from './evolution/messageBuffer.js'
import { flushSession } from './evolution/webhookEvolution.js'

const DEFAULT_INTERVAL_SEC = 30
const DEFAULT_DEBOUNCE_SEC = 15

let intervalHandle = null
let running = false

function getIntervalMs(env) {
  const v = Number(env.KOMMO_SCHEDULER_INTERVAL_SEC)
  const sec = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_INTERVAL_SEC
  return sec * 1000
}

function getDebounceMs(env) {
  const v = Number(env.KOMMO_SCHEDULER_DEBOUNCE_SEC)
  const sec = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_DEBOUNCE_SEC
  return sec * 1000
}

function isEnabled(env) {
  const flag = String(env.KOMMO_SCHEDULER_ENABLED || '').trim().toLowerCase()
  if (flag === 'false' || flag === '0' || flag === 'no') return false
  // Sem pipeline/status configurados não tem como filtrar — desabilita.
  if (!env.KOMMO_AGENT_PIPELINE_ID || !env.KOMMO_AGENT_STATUS_ID) return false
  if (!env.KOMMO_BASE_URL || !env.KOMMO_ACCESS_TOKEN) return false
  return true
}

function buildSessionId(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

function getTestLeadWhitelist(env) {
  const raw = String(env.KOMMO_AGENT_TEST_LEAD_IDS || '').trim()
  if (!raw) return null
  const ids = raw
    .split(/[,\s;]+/)
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  return ids.length > 0 ? new Set(ids) : null
}

/**
 * Executa um único tick do scheduler.
 *
 * @returns {Promise<{leadsInFunnel:number, processed:number, skippedDebounce:number, skippedNoMessages:number, errors:number}>}
 */
export async function runSchedulerTick(env) {
  const stats = { leadsInFunnel: 0, processed: 0, skippedDebounce: 0, skippedNoMessages: 0, skippedNotInWhitelist: 0, errors: 0 }
  if (!isEnabled(env)) return stats

  const pipelineId = Number(env.KOMMO_AGENT_PIPELINE_ID)
  const statusId = Number(env.KOMMO_AGENT_STATUS_ID)
  const debounceMs = getDebounceMs(env)
  const whitelist = getTestLeadWhitelist(env)

  // 1) Listar leads no funil/status
  const listing = await listLeadsByStatus(env, { pipelineId, statusId })
  if (!listing.ok) {
    console.error('[scheduler] kommo list falhou:', listing.error || listing.status)
    return stats
  }
  const leadsAll = listing.leads || []
  stats.leadsInFunnel = leadsAll.length

  // Whitelist de teste: descarta leads fora da lista ANTES do bulk de
  // contatos, evitando 1 chamada Kommo extra à toa.
  let leads = leadsAll
  if (whitelist) {
    leads = leadsAll.filter((l) => whitelist.has(Number(l.id)))
    stats.skippedNotInWhitelist = leadsAll.length - leads.length
    if (stats.skippedNotInWhitelist > 0) {
      console.log(`[scheduler] whitelist ativa — ${leads.length}/${leadsAll.length} leads passaram (ids permitidos: ${[...whitelist].join(',')})`)
    }
  }
  if (!leads.length) return stats

  // 2) Coletar contact IDs e bulk-fetch
  const contactIds = []
  for (const lead of leads) {
    const cs = lead?._embedded?.contacts || []
    for (const c of cs) {
      if (Number.isFinite(Number(c.id))) contactIds.push(Number(c.id))
    }
  }
  const contactById = new Map()
  if (contactIds.length > 0) {
    const bulk = await bulkGetContactsByIds(env, contactIds)
    if (bulk.ok) {
      for (const c of bulk.contacts) contactById.set(Number(c.id), c)
    } else {
      console.warn('[scheduler] bulkGetContactsByIds falhou:', bulk.error || bulk.status)
    }
  }

  // 3) Pra cada lead, achar telefone, ver buffer, processar se tiver fila
  // pronta. Processamos em paralelo mas com lock por sessão (no flushSession).
  const tasks = leads.map(async (lead) => {
    try {
      const cs = lead?._embedded?.contacts || []
      let phone = null
      for (const c of cs) {
        const detail = contactById.get(Number(c.id))
        if (!detail) continue
        const p = extractContactPhone(detail)
        if (p) { phone = p; break }
      }
      if (!phone) return
      const sessionId = buildSessionId(phone)
      if (!sessionId) return

      const messages = await getMessages(env, sessionId)
      if (!messages || messages.length === 0) {
        stats.skippedNoMessages += 1
        return
      }
      const last = await getLastTouchedAt(env, sessionId)
      const ageMs = last ? Date.now() - last.getTime() : Infinity
      if (ageMs < debounceMs) {
        stats.skippedDebounce += 1
        return
      }

      console.log(`[scheduler] flush ${sessionId} lead=${lead.id} (${messages.length} msgs, idade=${Math.round(ageMs / 1000)}s)`)
      await flushSession(env, sessionId, { leadIdHint: lead.id })
      stats.processed += 1
    } catch (err) {
      stats.errors += 1
      console.error('[scheduler] erro processando lead', lead?.id, err.message)
    }
  })

  await Promise.all(tasks)
  return stats
}

/**
 * Inicia o loop. Idempotente — chama várias vezes não cria múltiplos timers.
 */
export function startAgentScheduler(env) {
  if (intervalHandle) return { started: false, reason: 'already_running' }
  if (!isEnabled(env)) {
    return { started: false, reason: 'disabled (faltam KOMMO_AGENT_PIPELINE_ID / KOMMO_AGENT_STATUS_ID / token)' }
  }
  const intervalMs = getIntervalMs(env)
  const tick = () => {
    if (running) return // skip se o tick anterior ainda tá rodando
    running = true
    runSchedulerTick(env)
      .then((stats) => {
        if (stats.processed > 0 || stats.errors > 0) {
          const wl = stats.skippedNotInWhitelist ? `, ${stats.skippedNotInWhitelist} fora da whitelist` : ''
          console.log(
            `[scheduler] tick: ${stats.leadsInFunnel} no funil, ${stats.processed} processados, ${stats.skippedDebounce} aguardando debounce, ${stats.skippedNoMessages} sem msg${wl}, ${stats.errors} erros`,
          )
        }
      })
      .catch((err) => console.error('[scheduler] tick exception:', err.message))
      .finally(() => { running = false })
  }
  intervalHandle = setInterval(tick, intervalMs)
  // Roda um tick depois de 5s pra não competir com o boot.
  setTimeout(tick, 5000)
  console.log(`[scheduler] iniciado (intervalo=${Math.round(intervalMs / 1000)}s, debounce=${Math.round(getDebounceMs(env) / 1000)}s)`)
  return { started: true, intervalMs }
}

export function stopAgentScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  running = false
}

export function isSchedulerRunning() {
  return Boolean(intervalHandle)
}
