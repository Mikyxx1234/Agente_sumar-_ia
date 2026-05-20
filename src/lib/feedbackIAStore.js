/**
 * Cliente do front para o Feedback IA. Todas as chamadas batem nos
 * endpoints `/api/feedback-ia/*` do Express. Em dev, o proxy do Vite
 * encaminha pra :8000 automaticamente.
 */

const BASE = '/api/feedback-ia'

async function jsonFetch(url, init) {
  try {
    const res = await fetch(url, init)
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { ok: false, error: text }
    }
    return { httpOk: res.ok, status: res.status, ...data }
  } catch (e) {
    return { httpOk: false, ok: false, error: e.message }
  }
}

export async function getStats() {
  return jsonFetch(`${BASE}/stats`)
}

export async function listEvaluations({ sinceIso, untilIso, verdict, leadId, limit = 200 } = {}) {
  const qs = new URLSearchParams()
  if (sinceIso) qs.set('since', sinceIso)
  if (untilIso) qs.set('until', untilIso)
  if (verdict) qs.set('verdict', verdict)
  if (leadId) qs.set('leadId', String(leadId))
  if (limit) qs.set('limit', String(limit))
  return jsonFetch(`${BASE}/evaluations?${qs.toString()}`)
}

export async function evaluateNow({ leadId, telefone, sinceIso, untilIso } = {}) {
  return jsonFetch(`${BASE}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, telefone, sinceIso, untilIso, trigger: 'manual' }),
  })
}

export async function enqueueLeads(leadIds) {
  return jsonFetch(`${BASE}/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadIds }),
  })
}
