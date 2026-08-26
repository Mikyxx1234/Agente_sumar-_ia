/**
 * Backfill idempotente (lote): dados_cliente_sum → EduIT CUIDs.
 *
 * NÃO faz lookup linha-a-linha por telefone.
 * 1) Carrega candidatos Supabase
 * 2) Lista deals por stage (todas as etapas conhecidas)
 * 3) Indexa por telefone do contact embutido
 * 4) Conversas só para contactIds encontrados (cache)
 * 5) Fallback limitado getDealById para deals incompletos na listagem
 *
 * Uso:
 *   node scripts/backfill-eduit-ids.mjs              # dry-run (default)
 *   node scripts/backfill-eduit-ids.mjs --apply
 *   node scripts/backfill-eduit-ids.mjs --limit=50
 *
 * Env:
 *   EDUIT_BASE_URL, EDUIT_API_KEY, SUPABASE_URL, SUPABASE_KEY
 *   EDUIT_BACKFILL_DELAY_MS=150   throttle entre calls EduIT (default 150)
 *   EDUIT_BACKFILL_MAX_RETRIES=6
 *   EDUIT_BACKFILL_DEAL_DETAIL_CAP=200  máx. getDealById de enriquecimento
 * Nunca loga a API key.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveEduitStages,
  isEduitCuid,
  listConversationsByContactId,
  getDealById,
  pickPreferredDeal,
  contactPhoneDigits,
  eduitFetch,
} from '../server/eduitClient.js'
import { normalizeTelefone } from '../server/dadosClienteStore.js'
import {
  stageIdsForBackfill,
  buildDealPhoneIndex,
  lookupPreferredDealForPhone,
  dealNeedsDetailEnrichment,
  extractContactIdFromDeal,
  parseRetryAfterMs,
  isRateLimitResult,
} from './lib/backfillEduitIndex.mjs'

function loadDotEnv() {
  const p = resolve(process.cwd(), '.env')
  if (!existsSync(p)) return
  const text = readFileSync(p, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (process.env[k] == null || process.env[k] === '') process.env[k] = v
  }
}

function parseArgs(argv) {
  const out = { apply: false, limit: 0 }
  for (const a of argv) {
    if (a === '--apply') out.apply = true
    else if (a.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length))
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n)
    }
  }
  return out
}

function getSupabase(env) {
  const url = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = String(env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '')
  const table = env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum'
  return { url, key, table }
}

function getDelayMs(env) {
  const v = Number(env.EDUIT_BACKFILL_DELAY_MS)
  if (Number.isFinite(v) && v >= 0) return Math.floor(v)
  return 150
}

function getMaxRetries(env) {
  const v = Number(env.EDUIT_BACKFILL_MAX_RETRIES)
  if (Number.isFinite(v) && v >= 0) return Math.floor(v)
  return 6
}

function getDealDetailCap(env) {
  const v = Number(env.EDUIT_BACKFILL_DEAL_DETAIL_CAP)
  if (Number.isFinite(v) && v >= 0) return Math.floor(v)
  return 200
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

async function supabaseGet(url, key, pathAndQuery) {
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    method: 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { ok: res.ok, status: res.status, data, raw: text }
}

async function supabasePatch(url, key, table, telefoneDigits, fields) {
  const jid = `${telefoneDigits}@s.whatsapp.net`
  const filter = `or=(telefone.eq.${encodeURIComponent(telefoneDigits)},telefone.eq.${encodeURIComponent(jid)})`
  const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(fields),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { ok: res.ok, status: res.status, data, raw: text }
}

function needsBackfill(row) {
  const deal = row.eduit_deal_id && isEduitCuid(row.eduit_deal_id)
  const contact = row.eduit_contact_id && isEduitCuid(row.eduit_contact_id)
  const conv = row.eduit_conversation_id && isEduitCuid(row.eduit_conversation_id)
  const idLeadOk = row.id_lead && isEduitCuid(row.id_lead)
  return !(deal && contact && conv && idLeadOk)
}

/**
 * Throttle + retry 429 só neste script (não altera eduitFetch global).
 * Aceita uma função async que devolve shape { ok, status, error?, raw? }.
 */
export async function withThrottleRetry(fn, { delayMs, maxRetries, label = 'eduit' } = {}) {
  let attempt = 0
  // delay antes da 1ª call para espaçar lotes
  if (delayMs > 0) await sleep(delayMs)
  while (true) {
    const r = await fn()
    if (!isRateLimitResult(r) || attempt >= maxRetries) return r
    attempt += 1
    const retryAfter =
      r.retryAfterMs ??
      parseRetryAfterMs(r.headers?.get?.('retry-after'), Math.min(30_000, 500 * 2 ** attempt))
    const wait = Math.max(delayMs, retryAfter)
    console.warn(
      `[backfill-eduit] rate limit ${label} attempt=${attempt}/${maxRetries} wait=${wait}ms`,
    )
    await sleep(wait)
  }
}

/**
 * Lista deals de um stage com paginação e retry por página (via eduitFetch throttled).
 * Usa perPage alto e maxPages generoso — volume ~stages×páginas, não ×linhas Supabase.
 */
async function listDealsByStageThrottled(env, stageId, { delayMs, maxRetries }) {
  const all = []
  let page = 1
  const perPage = 100
  const maxPages = 50
  let total = null
  let lastStatus = null

  while (page <= maxPages) {
    const qs = new URLSearchParams({
      stageId: String(stageId),
      perPage: String(perPage),
      page: String(page),
    })
    const r = await withThrottleRetry(
      () => eduitFetch(env, `/api/deals?${qs}`),
      { delayMs, maxRetries, label: `deals stage=${String(stageId).slice(0, 12)} p=${page}` },
    )
    lastStatus = r.status
    if (!r.ok) {
      return {
        ok: all.length > 0,
        deals: all,
        error: r.error || `status ${r.status}`,
        status: r.status,
        code: r.code,
      }
    }
    const batch = Array.isArray(r.data?.items)
      ? r.data.items
      : Array.isArray(r.data)
        ? r.data
        : Array.isArray(r.data?.deals)
          ? r.data.deals
          : r.data?.id
            ? [r.data]
            : []
    total = r.data?.total ?? total
    all.push(...batch)
    if (batch.length < perPage) break
    if (total != null && all.length >= total) break
    page += 1
  }
  return { ok: true, deals: all, total: total ?? all.length, status: lastStatus }
}

async function main() {
  loadDotEnv()
  const args = parseArgs(process.argv.slice(2))
  const env = process.env
  const { url, key, table } = getSupabase(env)
  const delayMs = getDelayMs(env)
  const maxRetries = getMaxRetries(env)
  const detailCap = getDealDetailCap(env)

  if (!url || !key) {
    console.error('Configure SUPABASE_URL e SUPABASE_KEY')
    process.exit(1)
  }
  if (!env.EDUIT_BASE_URL || !env.EDUIT_API_KEY) {
    console.error('Configure EDUIT_BASE_URL e EDUIT_API_KEY')
    process.exit(1)
  }

  const stages = resolveEduitStages(env)
  const stageIds = stageIdsForBackfill(stages)
  console.log(
    `[backfill-eduit] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} table=${table} ` +
      `stages=${stageIds.length} delayMs=${delayMs} maxRetries=${maxRetries} detailCap=${detailCap}`,
  )

  // 1) Supabase — carrega todas as linhas (limit só no processamento)
  const pageSize = 200
  let offset = 0
  const rows = []
  while (true) {
    const q =
      `${table}?select=id,telefone,id_lead,eduit_deal_id,eduit_contact_id,eduit_conversation_id` +
      `&order=id.asc&limit=${pageSize}&offset=${offset}`
    const r = await supabaseGet(url, key, q)
    if (!r.ok) {
      console.error('Supabase list failed', r.status, String(r.raw || '').slice(0, 200))
      process.exit(1)
    }
    const batch = Array.isArray(r.data) ? r.data : []
    rows.push(...batch)
    if (batch.length < pageSize) break
    offset += pageSize
  }

  const candidates = rows.filter((row) => {
    const tel = normalizeTelefone(row.telefone)
    return tel && needsBackfill(row)
  })
  const work = args.limit ? candidates.slice(0, args.limit) : candidates
  const workPhones = new Set(work.map((r) => normalizeTelefone(r.telefone)).filter(Boolean))

  console.log(
    `[backfill-eduit] rows=${rows.length} candidatos=${candidates.length} processando=${work.length}`,
  )

  // 2) Lista deals por stage (índice EduIT integral)
  const dealsById = new Map()
  let stageErrors = 0
  for (const stageId of stageIds) {
    console.log(`[backfill-eduit] listing deals stage=${stageId}`)
    const listing = await listDealsByStageThrottled(env, stageId, { delayMs, maxRetries })
    if (!listing.ok && !(listing.deals || []).length) {
      stageErrors += 1
      console.warn(`[backfill-eduit] stage list failed ${stageId}: ${listing.error || listing.status}`)
      continue
    }
    for (const d of listing.deals || []) {
      if (d?.id) dealsById.set(String(d.id), d)
    }
    console.log(
      `[backfill-eduit] stage=${stageId} got=${(listing.deals || []).length} uniqueTotal=${dealsById.size}`,
    )
  }

  // 5) Fallback limitado: enriquecer deals sem phone/contactId
  const dealDetailCache = new Map()
  let detailFetches = 0
  const incomplete = [...dealsById.values()].filter((d) =>
    dealNeedsDetailEnrichment(d, contactPhoneDigits),
  )
  for (const d of incomplete) {
    if (detailFetches >= detailCap) {
      console.warn(
        `[backfill-eduit] deal detail cap=${detailCap} atingido — restantes sem enrich`,
      )
      break
    }
    const id = String(d.id)
    if (dealDetailCache.has(id)) {
      const cached = dealDetailCache.get(id)
      if (cached) dealsById.set(id, cached)
      continue
    }
    detailFetches += 1
    const got = await withThrottleRetry(() => getDealById(env, id), {
      delayMs,
      maxRetries,
      label: `dealDetail ${id.slice(0, 14)}`,
    })
    if (got.ok && got.deal) {
      dealDetailCache.set(id, got.deal)
      dealsById.set(id, got.deal)
    } else {
      dealDetailCache.set(id, null)
      if (isRateLimitResult(got)) {
        console.warn(`[backfill-eduit] deal detail still rate-limited id=${id}`)
      }
    }
  }

  const allDeals = [...dealsById.values()]
  // 3) Índice por telefone
  const phoneIndex = buildDealPhoneIndex(allDeals, contactPhoneDigits)
  console.log(
    `[backfill-eduit] dealsIndexed=${allDeals.length} phoneKeys=${phoneIndex.size} detailFetches=${detailFetches}`,
  )

  // 4) Conversas só para contactIds dos telefones do work set
  const conversationByContactId = new Map()
  let conversationFetches = 0
  let conversationHits = 0

  const summary = {
    dryRun: !args.apply,
    processed: 0,
    wouldUpdate: 0,
    updated: 0,
    skippedNoContact: 0,
    skippedNoDeal: 0,
    skippedNoChange: 0,
    errors: 0,
    stageErrors,
    detailFetches,
    conversationFetches: 0,
    eduitDeals: allDeals.length,
    decisions: [],
  }

  async function resolveConversation(contactId) {
    if (!contactId || !isEduitCuid(contactId)) return null
    if (conversationByContactId.has(contactId)) {
      return conversationByContactId.get(contactId)
    }
    conversationFetches += 1
    const r = await withThrottleRetry(() => listConversationsByContactId(env, contactId), {
      delayMs,
      maxRetries,
      label: `conv ${contactId.slice(0, 14)}`,
    })
    if (!r.ok) {
      conversationByContactId.set(contactId, null)
      return null
    }
    const id = r.conversation?.id ? String(r.conversation.id) : null
    conversationByContactId.set(contactId, id)
    if (id) conversationHits += 1
    return id
  }

  for (const row of work) {
    summary.processed += 1
    const tel = normalizeTelefone(row.telefone)
    try {
      const looked = lookupPreferredDealForPhone(phoneIndex, tel, pickPreferredDeal, env)
      if (!looked.deal) {
        // Sem deal no índice — não é erro de API; deal não encontrado no lote por stage
        summary.skippedNoDeal += 1
        summary.decisions.push({ telefone: tel, action: 'skip', reason: 'not_in_eduit_stage_index' })
        continue
      }

      let contactId = looked.contactId
      if (!contactId) {
        contactId = extractContactIdFromDeal(looked.deal)
      }
      // Se ainda sem contactId após enrich, tenta getDealById uma vez (cache)
      if (!contactId && looked.deal.id && detailFetches < detailCap + 50) {
        const id = String(looked.deal.id)
        let detailed = dealDetailCache.get(id)
        if (detailed === undefined) {
          detailFetches += 1
          const got = await withThrottleRetry(() => getDealById(env, id), {
            delayMs,
            maxRetries,
            label: `dealFallback ${id.slice(0, 14)}`,
          })
          detailed = got.ok ? got.deal : null
          dealDetailCache.set(id, detailed)
          if (detailed) dealsById.set(id, detailed)
        }
        if (detailed) {
          contactId = extractContactIdFromDeal(detailed)
          looked.deal = detailed
        }
      }

      if (!contactId) {
        summary.skippedNoContact += 1
        summary.decisions.push({
          telefone: tel,
          action: 'skip',
          reason: 'deal_without_contactId',
          dealId: String(looked.deal.id),
        })
        continue
      }

      const dealId = String(looked.deal.id)
      if (!isEduitCuid(dealId)) {
        summary.errors += 1
        summary.decisions.push({ telefone: tel, action: 'error', error: 'deal_id_not_cuid' })
        continue
      }

      const conversationId = await resolveConversation(contactId)

      const fields = {
        eduit_deal_id: dealId,
        eduit_contact_id: contactId,
        id_lead: dealId,
      }
      if (conversationId && isEduitCuid(conversationId)) {
        fields.eduit_conversation_id = conversationId
      }

      const same =
        String(row.eduit_deal_id || '') === fields.eduit_deal_id &&
        String(row.eduit_contact_id || '') === fields.eduit_contact_id &&
        String(row.eduit_conversation_id || '') === String(fields.eduit_conversation_id || '') &&
        String(row.id_lead || '') === fields.id_lead

      if (same) {
        summary.skippedNoChange += 1
        summary.decisions.push({
          telefone: tel,
          action: 'noop',
          dealPickReason: looked.dealPickReason,
        })
        continue
      }

      const decision = {
        telefone: tel,
        action: args.apply ? 'update' : 'would_update',
        dealId,
        contactId,
        conversationId: fields.eduit_conversation_id || null,
        dealPickReason: looked.dealPickReason,
        dealsMatched: looked.dealsMatched,
      }

      if (!args.apply) {
        summary.wouldUpdate += 1
        summary.decisions.push(decision)
        if (summary.wouldUpdate <= 30 || summary.wouldUpdate % 50 === 0) {
          console.log(
            `[backfill-eduit] DRY ${tel} → deal=${dealId} contact=${contactId} ` +
              `conv=${fields.eduit_conversation_id || 'n/a'} pick=${looked.dealPickReason}`,
          )
        }
        continue
      }

      const patch = await supabasePatch(url, key, table, tel, fields)
      if (!patch.ok) {
        summary.errors += 1
        decision.action = 'patch_failed'
        decision.error = String(patch.raw || '').slice(0, 200)
        summary.decisions.push(decision)
        console.warn(`[backfill-eduit] ${tel} patch failed: ${decision.error}`)
        continue
      }
      summary.updated += 1
      summary.decisions.push(decision)
      console.log(`[backfill-eduit] OK ${tel} → deal=${dealId} pick=${looked.dealPickReason}`)
    } catch (e) {
      summary.errors += 1
      summary.decisions.push({ telefone: tel, action: 'exception', error: e.message })
      console.warn(`[backfill-eduit] ${tel} exception:`, e.message)
    }
  }

  summary.conversationFetches = conversationFetches
  summary.detailFetches = detailFetches

  console.log(
    '[backfill-eduit] summary',
    JSON.stringify({
      dryRun: summary.dryRun,
      processed: summary.processed,
      wouldUpdate: summary.wouldUpdate,
      updated: summary.updated,
      skippedNoContact: summary.skippedNoContact,
      skippedNoDeal: summary.skippedNoDeal,
      skippedNoChange: summary.skippedNoChange,
      errors: summary.errors,
      eduitDeals: summary.eduitDeals,
      phoneIndexKeys: phoneIndex.size,
      stageErrors: summary.stageErrors,
      detailFetches: summary.detailFetches,
      conversationFetches: summary.conversationFetches,
      conversationHits,
      workPhones: workPhones.size,
    }),
  )
}

const isMain = (() => {
  try {
    const self = fileURLToPath(import.meta.url)
    const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
    return Boolean(invoked) && resolve(self) === resolve(invoked)
  } catch {
    return true
  }
})()

if (isMain) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}