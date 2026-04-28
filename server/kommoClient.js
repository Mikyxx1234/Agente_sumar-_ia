/**
 * Cliente mínimo da API do Kommo — só o que a gente precisa para ligar envio
 * de mensagens pelo WhatsApp (nota no lead) e para descobrir o id_lead a partir
 * do telefone.
 *
 * Hoje o inscricaoTool / distribuirHumanoTool têm cópias locais de kommoFetch;
 * o ideal é migrar essas tools para usarem este módulo, mas isso fica para um
 * refactor separado.
 *
 * Env:
 *   KOMMO_BASE_URL       ex: https://admamoeduitcombr.kommo.com
 *   KOMMO_ACCESS_TOKEN   Bearer (OAuth ou long-lived)
 */

function getConfig(env) {
  return {
    base: (env.KOMMO_BASE_URL || '').replace(/\/$/, ''),
    token: env.KOMMO_ACCESS_TOKEN || '',
  }
}

async function kommoFetch(env, path, { method = 'GET', body } = {}) {
  const { base, token } = getConfig(env)
  if (!base || !token) {
    return {
      ok: false,
      code: 'KOMMO_NOT_CONFIGURED',
      error: 'Configure KOMMO_BASE_URL e KOMMO_ACCESS_TOKEN.',
    }
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const raw = await res.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
    return { ok: res.ok, status: res.status, data, raw }
  } catch (e) {
    return { ok: false, code: 'KOMMO_FETCH_FAILED', error: e.message }
  }
}

function summarizeError(r) {
  if (r.error) return r.error
  if (typeof r.raw === 'string') return r.raw.slice(0, 400)
  return `status ${r.status}`
}

/**
 * Busca o primeiro lead associado ao telefone.
 * Usa o search full-text do Kommo (?query=<digitos>) que inclui telefones de
 * contatos vinculados ao lead.
 *
 * @returns { ok, lead?, matched, status?, error? }
 */
export async function findLeadByPhone(env, telefone) {
  const digits = String(telefone || '').replace(/[^0-9]/g, '')
  if (!digits) {
    return { ok: false, code: 'MISSING_TELEFONE', error: 'telefone vazio', matched: 0 }
  }
  const r = await kommoFetch(
    env,
    `/api/v4/leads?query=${encodeURIComponent(digits)}&with=contacts&limit=10`,
  )
  if (!r.ok) {
    return { ok: false, code: r.code || 'KOMMO_ERROR', status: r.status, error: summarizeError(r), matched: 0 }
  }
  const leads = r.data?._embedded?.leads || []
  return {
    ok: true,
    lead: leads[0] || null,
    matched: leads.length,
    leads,
  }
}

/**
 * Lista todos os leads que estão num pipeline + status específicos.
 * Pagina automaticamente até esgotar (`_links.next`).
 *
 * Inclui contacts no embed (apenas {id, is_main}). Para pegar o telefone
 * use bulkGetContactsByIds com os contact ids retornados.
 *
 * @returns { ok, leads, status?, error? }
 */
export async function listLeadsByStatus(env, { pipelineId, statusId, limit = 250, maxPages = 10 } = {}) {
  const sid = Number(statusId)
  if (!Number.isFinite(sid) || sid <= 0) {
    return { ok: false, code: 'MISSING_STATUS_ID', error: 'statusId inválido', leads: [] }
  }
  const all = []
  let page = 1
  while (page <= maxPages) {
    const params = [
      `filter[statuses][0][status_id]=${sid}`,
      `with=contacts`,
      `limit=${Math.min(250, Math.max(1, Number(limit) || 250))}`,
      `page=${page}`,
    ]
    if (Number.isFinite(Number(pipelineId)) && Number(pipelineId) > 0) {
      params.unshift(`filter[statuses][0][pipeline_id]=${Number(pipelineId)}`)
    }
    const r = await kommoFetch(env, `/api/v4/leads?${params.join('&')}`)
    if (!r.ok) {
      // 204 vira ok=false em alguns ambientes — tratar 204/sem corpo como vazio
      if (r.status === 204) return { ok: true, leads: all }
      return { ok: false, code: r.code || 'KOMMO_ERROR', status: r.status, error: summarizeError(r), leads: all }
    }
    const leads = r.data?._embedded?.leads || []
    all.push(...leads)
    if (!r.data?._links?.next) break
    page += 1
  }
  return { ok: true, leads: all }
}

/**
 * Busca múltiplos contatos numa única chamada (até ~50 por request, paginando
 * se passar disso). Retorna o array com todos os contatos completos, incluindo
 * custom_fields_values.
 *
 * @returns { ok, contacts, error? }
 */
export async function bulkGetContactsByIds(env, ids) {
  const list = Array.from(new Set((ids || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)))
  if (!list.length) return { ok: true, contacts: [] }

  const all = []
  const chunkSize = 40 // Kommo aceita filter[id][n] múltiplos; mantemos baixo p/ não estourar URL
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize)
    const params = chunk.map((id, idx) => `filter[id][${idx}]=${id}`).join('&')
    const r = await kommoFetch(env, `/api/v4/contacts?${params}&limit=250`)
    if (!r.ok) {
      if (r.status === 204) continue
      return { ok: false, code: r.code || 'KOMMO_ERROR', status: r.status, error: summarizeError(r), contacts: all }
    }
    const contacts = r.data?._embedded?.contacts || []
    all.push(...contacts)
  }
  return { ok: true, contacts: all }
}

/**
 * Extrai o telefone de um contato Kommo (procura no custom_fields_values).
 * Retorna o primeiro telefone encontrado (string, com ou sem '+'), ou null.
 */
export function extractContactPhone(contact) {
  const fields = contact?.custom_fields_values
  if (!Array.isArray(fields)) return null
  for (const f of fields) {
    const code = String(f?.field_code || '').toUpperCase()
    if (code !== 'PHONE') continue
    const values = f?.values
    if (!Array.isArray(values) || values.length === 0) continue
    for (const v of values) {
      const phone = v?.value
      if (phone && typeof phone === 'string') return phone
    }
  }
  return null
}

/**
 * Cria uma nota comum no lead indicado.
 * @returns { ok, status?, data?, error? }
 */
export async function createLeadNote(env, leadId, text) {
  if (leadId == null || leadId === '') {
    return { ok: false, code: 'MISSING_LEAD_ID', error: 'leadId ausente' }
  }
  const r = await kommoFetch(env, `/api/v4/leads/${leadId}/notes`, {
    method: 'POST',
    body: [{ note_type: 'common', params: { text: String(text ?? '') } }],
  })
  if (!r.ok) {
    return { ok: false, code: r.code || 'KOMMO_ERROR', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, status: r.status, data: r.data }
}
