/**
 * Helpers puros — índice em lote do backfill EduIT (testáveis sem API).
 */

/** Stage CUIDs de resolveEduitStages, sem pipelineId, deduplicados. */
export function stageIdsForBackfill(stages) {
  if (!stages || typeof stages !== 'object') return []
  const out = []
  const seen = new Set()
  for (const [key, value] of Object.entries(stages)) {
    if (key === 'pipelineId') continue
    const id = String(value || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function digitsOnly(input) {
  return String(input || '').replace(/[^0-9]/g, '')
}

/** Variantes BR com/sem 55 para indexar e buscar. */
export function phoneVariants(digits) {
  const d = digitsOnly(digits)
  if (!d) return []
  const set = new Set([d])
  if (d.startsWith('55') && d.length >= 12) set.add(d.slice(2))
  else if (d.length >= 10 && d.length <= 11) set.add(`55${d}`)
  return [...set]
}

export function extractContactIdFromDeal(deal) {
  if (!deal || typeof deal !== 'object') return null
  const candidates = [
    deal.contactId,
    deal.contact_id,
    deal.contact?.id,
    deal.contact?.contactId,
    deal._embedded?.contact?.id,
    deal._embedded?.contacts?.[0]?.id,
  ]
  for (const c of candidates) {
    const s = c != null ? String(c).trim() : ''
    if (s) return s
  }
  return null
}

/**
 * Telefones do deal (lista + contact embutido).
 * @param {object} deal
 * @param {(contact: object) => string[]} [contactPhoneDigitsFn]
 */
export function extractPhonesFromDeal(deal, contactPhoneDigitsFn) {
  if (!deal || typeof deal !== 'object') return []
  const out = []
  const push = (v) => {
    const d = digitsOnly(v)
    if (d) out.push(d)
  }
  push(deal.phone)
  push(deal.whatsapp)
  push(deal.telefone)
  const contact = deal.contact || deal.Contact || deal._embedded?.contact || null
  if (contact) {
    push(contact.phone)
    push(contact.whatsapp)
    push(contact.mobile)
    push(contact.telefone)
    if (typeof contactPhoneDigitsFn === 'function') {
      for (const p of contactPhoneDigitsFn(contact) || []) push(p)
    }
  }
  const contacts = deal.contacts || deal._embedded?.contacts
  if (Array.isArray(contacts)) {
    for (const c of contacts) {
      push(c?.phone)
      push(c?.whatsapp)
      if (typeof contactPhoneDigitsFn === 'function') {
        for (const p of contactPhoneDigitsFn(c) || []) push(p)
      }
    }
  }
  return [...new Set(out)]
}

/**
 * Deal precisa de GET detalhe? (falta telefone ou contactId na listagem).
 */
export function dealNeedsDetailEnrichment(deal, contactPhoneDigitsFn) {
  if (!deal?.id) return false
  const contactId = extractContactIdFromDeal(deal)
  const phones = extractPhonesFromDeal(deal, contactPhoneDigitsFn)
  return !contactId || phones.length === 0
}

/**
 * Indexa deals por telefone (todas as variantes).
 * @returns {Map<string, object[]>}
 */
export function buildDealPhoneIndex(deals, contactPhoneDigitsFn) {
  const index = new Map()
  for (const deal of deals || []) {
    if (!deal?.id) continue
    const phones = extractPhonesFromDeal(deal, contactPhoneDigitsFn)
    for (const phone of phones) {
      for (const key of phoneVariants(phone)) {
        if (!index.has(key)) index.set(key, [])
        const list = index.get(key)
        if (!list.some((d) => String(d.id) === String(deal.id))) list.push(deal)
      }
    }
  }
  return index
}

/**
 * Resolve deal preferido + contactId para um telefone a partir do índice.
 * @returns {{ deal: object|null, contactId: string|null, dealsMatched: number, dealPickReason: string }}
 */
export function lookupPreferredDealForPhone(phoneIndex, telefone, pickPreferredDeal, env) {
  const variants = phoneVariants(telefone)
  const byId = new Map()
  for (const v of variants) {
    for (const d of phoneIndex.get(v) || []) {
      if (d?.id) byId.set(String(d.id), d)
    }
  }
  const deals = [...byId.values()]
  if (!deals.length) {
    return { deal: null, contactId: null, dealsMatched: 0, dealPickReason: 'no_deals' }
  }
  const { deal, reason } = pickPreferredDeal(deals, env)
  return {
    deal: deal || null,
    contactId: deal ? extractContactIdFromDeal(deal) : null,
    dealsMatched: deals.length,
    dealPickReason: reason || 'unknown',
  }
}

export function parseRetryAfterMs(headerValue, fallbackMs) {
  if (headerValue == null || headerValue === '') return fallbackMs
  const n = Number(headerValue)
  if (Number.isFinite(n) && n >= 0) {
    // Retry-After em segundos (HTTP) — se > 100 trata como ms já
    return n > 100 ? Math.floor(n) : Math.floor(n * 1000)
  }
  const date = Date.parse(String(headerValue))
  if (Number.isFinite(date)) {
    const delta = date - Date.now()
    return delta > 0 ? delta : fallbackMs
  }
  return fallbackMs
}

export function isRateLimitResult(r) {
  if (!r) return false
  if (r.status === 429) return true
  const err = String(r.error || r.raw || '').toLowerCase()
  return /rate.?limit|too many requests|429/.test(err)
}
