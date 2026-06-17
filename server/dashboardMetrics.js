/**
 * Métricas do dashboard — agrega mensagens_ia com paginação completa
 * (PostgREST limita ~1000 linhas por request) e filtro opcional por funil Kommo.
 */

import { calcCostBRL } from '../src/lib/openaiPricing.js'
import { listLeadsByStatus } from './kommoClient.js'

const PAGE_SIZE = 500
const FETCH_TIMEOUT_MS = 25_000
const DAY_FETCH_CONCURRENCY = 4

function sanitizeFetchError(raw) {
  const text = String(raw || '').trim()
  if (!text) return 'Erro desconhecido ao consultar Supabase'
  if (/^\s*<!DOCTYPE/i.test(text) || /^\s*<html/i.test(text)) {
    if (/522|timed out|timeout/i.test(text)) {
      return 'Supabase temporariamente indisponível (timeout) — aguarde 1–2 min e tente Hoje ou 3 dias'
    }
    return 'Timeout ou indisponibilidade do Supabase — tente um período menor (Hoje ou 3 dias)'
  }
  try {
    const j = JSON.parse(text)
    if (j?.message) return String(j.message)
    if (j?.error) return String(j.error)
  } catch {
    /* texto cru */
  }
  return text.slice(0, 200)
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`Timeout (${Math.round(timeoutMs / 1000)}s) ao consultar Supabase`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function getSupabaseConfig(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
  }
}

/** Limites do dia civil America/Sao_Paulo (UTC-3 fixo). */
export function saoPauloRangeIso(startDate, endDate) {
  const start = String(startDate || '').trim()
  const end = String(endDate || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return null
  }
  const [ey, em, ed] = end.split('-').map(Number)
  const endUtc = new Date(Date.UTC(ey, em - 1, ed + 1, 2, 59, 59, 999))
  return {
    startISO: `${start}T03:00:00.000Z`,
    endISO: endUtc.toISOString(),
  }
}

export function extractLeadIdFromRow(row) {
  const usage = row?.usage && typeof row.usage === 'object' ? row.usage : {}
  const fromUsage = Number(usage.lead_id)
  if (Number.isFinite(fromUsage) && fromUsage > 0) return fromUsage
  const steps = Array.isArray(row?.steps) ? row.steps : []
  for (const s of steps) {
    const candidate = s?.result?.leadId ?? s?.leadId ?? null
    const n = Number(candidate)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function rowMatchesScope(leadId, scopeLeadIds, scopeMode) {
  if (!scopeLeadIds) return true
  const n = Number(leadId)
  if (!Number.isFinite(n) || n <= 0) {
    return scopeMode === 'exclude'
  }
  const inSet = scopeLeadIds.has(n)
  return scopeMode === 'exclude' ? !inSet : inSet
}

function calcExecutionCostBRL(row) {
  const usage = row?.usage || {}
  const aiMeta = usage._meta || null
  let total = calcCostBRL(usage, row?.model)
  for (const u of aiMeta?.queryRewriteUsage || []) {
    total += calcCostBRL(u?.usage || {}, u?.model)
  }
  for (const u of aiMeta?.embeddingsUsage || []) {
    total += calcCostBRL(u?.usage || {}, u?.model)
  }
  for (const u of aiMeta?.toolUsage || []) {
    total += calcCostBRL(u?.usage || {}, u?.model)
  }
  for (const u of aiMeta?.scopeClassifierUsage || []) {
    total += calcCostBRL(u?.usage || {}, u?.model)
  }
  return total
}

export function extractWhatsappSendFromRow(row) {
  const usage = row?.usage && typeof row.usage === 'object' ? row.usage : {}
  const fromUsage = Number(usage.whatsapp_sent)
  if (Number.isFinite(fromUsage) && fromUsage > 0) {
    return { parts: fromUsage, confirmed: true }
  }

  let parts = 0
  let confirmed = false
  for (const s of row?.steps || []) {
    if (s?.tool !== 'whatsapp.sendMessageWithNote') continue
    const r = s?.result || {}
    const n = Number(r.sent)
    if (r.ok && Number.isFinite(n) && n > 0) {
      parts += n
      confirmed = true
    }
  }
  return { parts, confirmed }
}

function toLocalDateKey(iso) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function* iterDateKeys(startDate, endDate) {
  const start = new Date(startDate + 'T12:00:00')
  const end = new Date(endDate + 'T12:00:00')
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    yield toLocalDateKey(d)
  }
}

async function fetchScopedLeadIds(env, { pipelineId, statusIds }) {
  if (!statusIds?.length) return new Set()
  const pip = Number(pipelineId) || Number(env.KOMMO_AGENT_PIPELINE_ID) || 13756724
  const byId = new Map()
  for (const statusId of statusIds) {
    const listing = await listLeadsByStatus(env, { pipelineId: pip, statusId: Number(statusId) })
    if (!listing.ok) continue
    for (const lead of listing.leads || []) {
      const id = Number(lead?.id)
      if (Number.isFinite(id) && id > 0) byId.set(id, lead)
    }
  }
  return new Set(byId.keys())
}

async function fetchAllRows(env, startISO, endISO) {
  const { url, key } = getSupabaseConfig(env)
  if (!url || !key) return { ok: false, error: 'SUPABASE_NOT_CONFIGURED', rows: [] }
  const rows = []
  try {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const q =
        `mensagens_ia?select=id,created_at,model,steps,tool_calls,error,total_duration_ms,usage` +
        `&created_at=gte.${encodeURIComponent(startISO)}` +
        `&created_at=lte.${encodeURIComponent(endISO)}` +
        `&order=created_at.asc&limit=${PAGE_SIZE}&offset=${offset}`
      const r = await fetchWithTimeout(`${url}/rest/v1/${q}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      })
      if (!r.ok) {
        const err = await r.text().catch(() => '')
        return { ok: false, error: sanitizeFetchError(err) || `HTTP ${r.status}`, rows }
      }
      const batch = await r.json()
      if (!Array.isArray(batch) || !batch.length) break
      rows.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
    return { ok: true, rows }
  } catch (e) {
    return { ok: false, error: sanitizeFetchError(e.message), rows }
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/** Evita timeout do PostgREST em ranges longos (consulta dia a dia). */
async function fetchAllRowsForRange(env, startDate, endDate) {
  const dayKeys = [...iterDateKeys(startDate, endDate)]
  if (dayKeys.length <= 1) {
    const range = saoPauloRangeIso(startDate, endDate)
    return fetchAllRows(env, range.startISO, range.endISO)
  }
  const batches = await mapWithConcurrency(dayKeys, DAY_FETCH_CONCURRENCY, async (day) => {
    const range = saoPauloRangeIso(day, day)
    return fetchAllRows(env, range.startISO, range.endISO)
  })
  const rows = []
  for (const batch of batches) {
    if (!batch.ok) return batch
    rows.push(...batch.rows)
  }
  return { ok: true, rows }
}

/**
 * @param {Record<string,string>} env
 * @param {{ startDate: string, endDate: string, pipelineId?: number, statusIds?: number[], scopeMode?: 'include'|'exclude'|'all' }} opts
 */
export async function computeDashboardMetrics(env, opts) {
  const range = saoPauloRangeIso(opts.startDate, opts.endDate)
  if (!range) return { ok: false, error: 'INVALID_DATE_RANGE' }

  const scopeMode = opts.scopeMode || 'all'
  const scopeLeadIds =
    scopeMode === 'all'
      ? null
      : await fetchScopedLeadIds(env, {
          pipelineId: opts.pipelineId,
          statusIds: opts.statusIds,
          scopeMode,
        })

  const fetched = await fetchAllRowsForRange(env, opts.startDate, opts.endDate)
  if (!fetched.ok) return { ok: false, error: fetched.error }

  const filtered = []
  for (const row of fetched.rows) {
    const leadId = extractLeadIdFromRow(row)
    if (rowMatchesScope(leadId, scopeLeadIds, scopeMode)) filtered.push(row)
  }

  const totalDays = Math.max(
    1,
    Math.round(
      (new Date(opts.endDate + 'T12:00:00').getTime() -
        new Date(opts.startDate + 'T12:00:00').getTime()) /
        86400000,
    ) + 1,
  )

  const dayMap = {}
  const whatsappDayMap = {}
  const baseDate = new Date(opts.startDate + 'T12:00:00')
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(baseDate)
    d.setDate(baseDate.getDate() + i)
    const key = toLocalDateKey(d)
    dayMap[key] = 0
    whatsappDayMap[key] = 0
  }

  let tokens = 0
  let cost = 0
  let errors = 0
  let durationSum = 0
  let whatsappSentExecutions = 0
  let whatsappPartsCount = 0
  const toolCounts = {}
  const topicCounts = {}
  let costOrchestrator = 0
  let costRewrite = 0
  let costEmbeddings = 0
  let costAuxTools = 0

  const TOPIC_LABELS = {
    buscar_conhecimento: 'Busca base Sumaré (RAG)',
    buscar_precos: 'Pediu preço',
    buscar_informacoes: 'Pediu informações do curso',
    buscar_pos: 'Pediu pós-graduação',
    buscar_perguntas: 'Fez uma pergunta (FAQ)',
    localizacao: 'Pediu polo / localização',
    inscricao: 'Inscrição / matrícula',
    distribuir_humano: 'Distribuição para humano',
  }

  for (const row of filtered) {
    const usage = row.usage || {}
    const aiMeta = usage._meta || null
    tokens += Number(usage.total_tokens) || 0
    cost += calcExecutionCostBRL(row)
    if (row.error) errors += 1
    durationSum += Number(row.total_duration_ms) || 0

    costOrchestrator += calcCostBRL(usage, row.model)
    for (const u of aiMeta?.queryRewriteUsage || []) costRewrite += calcCostBRL(u?.usage || {}, u?.model)
    for (const u of aiMeta?.embeddingsUsage || []) costEmbeddings += calcCostBRL(u?.usage || {}, u?.model)
    for (const u of aiMeta?.toolUsage || []) costAuxTools += calcCostBRL(u?.usage || {}, u?.model)

    const dayKey = toLocalDateKey(row.created_at)
    if (dayMap[dayKey] != null) dayMap[dayKey] += 1

    const wa = extractWhatsappSendFromRow(row)
    if (wa.confirmed) {
      whatsappSentExecutions += 1
      whatsappPartsCount += wa.parts
      if (whatsappDayMap[dayKey] != null) whatsappDayMap[dayKey] += 1
    }

    for (const tc of row.tool_calls || []) {
      const name = tc?.tool || 'unknown'
      toolCounts[name] = (toolCounts[name] || 0) + 1
      const label = TOPIC_LABELS[name] || name
      topicCounts[label] = (topicCounts[label] || 0) + 1
    }
  }

  const messagesCount = filtered.length
  const avgTime = messagesCount > 0 ? Math.round(durationSum / messagesCount) : 0

  const chartData = Object.entries(dayMap).map(([key, value]) => {
    const [y, m, d] = key.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    return {
      label: date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
      value,
    }
  })

  return {
    ok: true,
    messagesCount,
    whatsappSentExecutions,
    whatsappPartsCount,
    tokens,
    cost,
    errorsCount: errors,
    avgTime,
    chartData,
    whatsappChartData: Object.entries(whatsappDayMap).map(([key, value]) => {
      const [y, m, d] = key.split('-').map(Number)
      const date = new Date(y, m - 1, d)
      return {
        label: date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
        value,
      }
    }),
    toolsData: Object.entries(toolCounts)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    topicsData: Object.entries(topicCounts)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    costBreakdown: [
      { key: 'orchestrator', label: 'Orquestrador (chat)', cost: costOrchestrator },
      { key: 'rewrite', label: 'Reescrita de query', cost: costRewrite },
      { key: 'embeddings', label: 'Embeddings (RAG)', cost: costEmbeddings },
      { key: 'auxTools', label: 'Tools auxiliares', cost: costAuxTools },
    ],
    meta: {
      fetchedTotal: fetched.rows.length,
      filteredTotal: messagesCount,
      scopeMode,
      scopeLeadCount: scopeLeadIds ? scopeLeadIds.size : null,
      range: range,
    },
  }
}
