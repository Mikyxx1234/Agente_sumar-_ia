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
 *   KOMMO_BASE_URL       ex: https://academicosoead.kommo.com
 *   KOMMO_ACCESS_TOKEN   Bearer (OAuth ou long-lived)
 */

import { AGENT_AUDIT_NOTE_MARKER } from '../libShared/inboundMessageSanitize.js'
import { kommoRawFetch } from './kommoRateLimiter.js'

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
  const requestUrl = `${base}${path}`
  try {
    const res = await kommoRawFetch(requestUrl, {
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
    return { ok: res.ok, status: res.status, data, raw, requestUrl }
  } catch (e) {
    return { ok: false, code: 'KOMMO_FETCH_FAILED', error: e.message, requestUrl }
  }
}

/**
 * Diagnóstico rápido da API Kommo (account + list leads no funil do agente).
 */
export async function probeKommoApi(env) {
  const { base, token } = getConfig(env)
  const out = {
    ok: false,
    baseUrl: base || null,
    tokenConfigured: Boolean(String(token || '').trim()),
    account: null,
    leadsSample: null,
    pipelineId: env.KOMMO_AGENT_PIPELINE_ID || null,
    statusIds: env.KOMMO_AGENT_STATUS_IDS || env.KOMMO_AGENT_STATUS_ID || null,
  }
  if (!base || !token) {
    out.error = 'KOMMO_BASE_URL ou KOMMO_ACCESS_TOKEN ausente'
    return out
  }
  const acc = await kommoFetch(env, '/api/v4/account')
  out.account = {
    ok: acc.ok,
    status: acc.status,
    requestUrl: acc.requestUrl,
    error: acc.ok ? null : summarizeError(acc),
    name: acc.data?.name || null,
  }
  if (!acc.ok) {
    out.error = out.account.error
    return out
  }
  const sid = Number(env.KOMMO_AGENT_STATUS_ID) || Number(String(env.KOMMO_AGENT_STATUS_IDS || '').split(/[,\s;]+/)[0])
  const pipelineId = Number(env.KOMMO_AGENT_PIPELINE_ID)
  if (Number.isFinite(sid) && sid > 0) {
    const leads = await listLeadsByStatus(env, { pipelineId, statusId: sid, limit: 1, maxPages: 1 })
    out.leadsSample = {
      ok: leads.ok,
      status: leads.status,
      count: (leads.leads || []).length,
      error: leads.ok ? null : leads.error,
    }
    out.ok = leads.ok
    if (!leads.ok) out.error = leads.error
  } else {
    out.ok = true
  }
  return out
}

function summarizeError(r) {
  if (r.error) return r.error
  if (typeof r.raw === 'string') {
    const raw = r.raw.trim()
    if (raw.startsWith('<') && /<html/i.test(raw)) {
      if (r.status === 403) {
        return (
          `HTTP 403 Forbidden (resposta HTML/nginx — não é JSON da API Kommo). ` +
          `Verifique KOMMO_BASE_URL (deve ser https://SUA_CONTA.kommo.com sem /api/v4 no final) ` +
          `e se o token OAuth ainda é válido. URL chamada: ${r.requestUrl || 'n/a'}`
        )
      }
      return `HTTP ${r.status || '?'} resposta HTML (proxy/WAF?), não JSON Kommo. URL: ${r.requestUrl || 'n/a'}`
    }
    return raw.slice(0, 400)
  }
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
 * Nome do lead/contato no Kommo (para exibir no painel ao lado do link CRM).
 *
 * @returns {Promise<{ ok: boolean, leadId?: number, name?: string|null, error?: string }>}
 */
/**
 * Lead Kommo por id (pipeline_id, status_id, etc.).
 * @returns {Promise<{ ok: boolean, lead?: object, status?: number, error?: string }>}
 */
export async function getLeadById(env, leadId) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, code: 'MISSING_LEAD_ID', error: 'leadId inválido' }
  }
  const r = await kommoFetch(env, `/api/v4/leads/${id}`)
  if (!r.ok) {
    return { ok: false, code: r.code || 'KOMMO_ERROR', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, lead: r.data, status: r.status }
}

export async function getLeadSummary(env, leadId) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: 'leadId inválido' }
  }
  const r = await kommoFetch(env, `/api/v4/leads/${id}?with=contacts`)
  if (!r.ok) {
    return { ok: false, status: r.status, error: summarizeError(r) }
  }
  const lead = r.data
  let name = lead?.name && String(lead.name).trim() ? String(lead.name).trim() : null
  const contact = lead?._embedded?.contacts?.[0]
  if (!name && contact?.name) name = String(contact.name).trim()

  let phone = extractLeadPhone(lead)
  if (!phone) {
    const contactIds = (lead?._embedded?.contacts || [])
      .map((c) => Number(c?.id))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (contactIds.length > 0) {
      const bulk = await bulkGetContactsByIds(env, contactIds)
      if (bulk.ok) {
        for (const c of bulk.contacts) {
          const p = extractContactPhone(c)
          if (p) { phone = p; if (!name && c.name) name = String(c.name).trim(); break }
        }
      }
    }
  }

  return { ok: true, leadId: id, name: name || null, phone: phone || null }
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

function pickFirstPhoneValue(values) {
  if (!Array.isArray(values)) return null
  for (const v of values) {
    const raw = v?.value
    if (raw == null) continue
    const s = String(raw).trim()
    if (s && /\d/.test(s)) return s
  }
  return null
}

/**
 * Indica se o custom field do Kommo/Amo é claramente um telefone.
 * Inclui `sum_telefone` (Faculdade Sumaré) além do field_code canônico PHONE.
 */
function isPhoneCustomField(f) {
  const codeRaw = String(f?.field_code || '').trim()
  const code = codeRaw.toUpperCase().replace(/-/g, '_')
  if (code === 'PHONE') return true
  // Campo custom Sumaré no Kommo (lead ou contato)
  if (code === 'SUM_TELEFONE') return true
  const name = String(f?.field_name || '')
  return /phone|telefone|celular|whatsapp|mobile|fone/i.test(name)
}

/**
 * Extrai o telefone de um contato Kommo (custom_fields_values).
 * Aceita field_code PHONE, SUM_TELEFONE / sum_telefone (Sumaré), field_name com "telefone"/etc.,
 * e valor numérico ou string.
 */
export function extractContactPhone(contact) {
  if (!contact) return null
  if (typeof contact.phone === 'string' && contact.phone.trim() && /\d/.test(contact.phone)) {
    return contact.phone.trim()
  }
  const fields = contact?.custom_fields_values
  if (!Array.isArray(fields)) return null
  for (const f of fields) {
    if (!isPhoneCustomField(f)) continue
    const phone = pickFirstPhoneValue(f?.values)
    if (phone) return phone
  }
  return null
}

/**
 * Telefone gravado no **lead** (não no contato). Alguns funis preenchem só aqui.
 */
export function extractLeadPhone(lead) {
  if (!lead) return null
  const fields = lead?.custom_fields_values
  if (!Array.isArray(fields)) return null
  for (const f of fields) {
    if (!isPhoneCustomField(f)) continue
    const phone = pickFirstPhoneValue(f?.values)
    if (phone) return phone
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
  return { ok: true, status: r.status, data: r.data, noteId: extractCreatedNoteId(r.data) }
}

/**
 * Nota de SMS/WhatsApp inbound — exibe a fala do candidato no timeline Kommo.
 * @returns { ok, status?, noteId?, error? }
 */
export async function createLeadSmsInNote(env, leadId, text, phone) {
  if (leadId == null || leadId === '') {
    return { ok: false, code: 'MISSING_LEAD_ID', error: 'leadId ausente' }
  }
  const body = {
    note_type: 'sms_in',
    params: {
      text: String(text ?? ''),
      phone: String(phone || '').trim() || undefined,
    },
  }
  if (!body.params.phone) delete body.params.phone
  const r = await kommoFetch(env, `/api/v4/leads/${leadId}/notes`, {
    method: 'POST',
    body: [body],
  })
  if (!r.ok) {
    return { ok: false, code: r.code || 'KOMMO_ERROR', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, status: r.status, data: r.data, noteId: extractCreatedNoteId(r.data) }
}

/**
 * Cria uma nota INTERNA de auditoria no lead (movimentação de funil, motivo de
 * perda, comprovante recebido, etc.). Injeta o marcador `AGENT_AUDIT_NOTE_MARKER`
 * para que o poll de inbound (kommoInboundPoll) nunca a leia como fala do
 * candidato. Use sempre que a nota for um registro do sistema — não uma
 * mensagem enviada ao lead.
 */
export async function createLeadAuditNote(env, leadId, text) {
  const raw = String(text ?? '').trim()
  // Idempotente: não duplica o marcador se já estiver presente.
  const tagged = /\[registro\s+interno\s+ia\]/i.test(raw)
    ? raw
    : `${raw} ${AGENT_AUDIT_NOTE_MARKER}`
  return createLeadNote(env, leadId, tagged)
}

function extractCreatedNoteId(data) {
  const fromEmbed = data?._embedded?.notes?.[0]?.id
  if (fromEmbed != null) return Number(fromEmbed) || null
  const fromArr = Array.isArray(data) ? data[0]?.id : data?.id
  if (fromArr != null) return Number(fromArr) || null
  return null
}

/**
 * Lista notas de um lead (timeline). Usado pelo poll de inbound sem webhook Evolution.
 *
 * @returns { ok, notes, status?, error? }
 */
export async function listLeadNotes(env, leadId, { limit = 50, order = 'desc' } = {}) {
  const lid = Number(leadId)
  if (!Number.isFinite(lid) || lid <= 0) {
    return { ok: false, code: 'MISSING_LEAD_ID', error: 'leadId inválido', notes: [] }
  }
  const lim = Math.min(250, Math.max(1, Number(limit) || 50))
  const ord = order === 'asc' ? 'asc' : 'desc'
  const q = `limit=${lim}&order[id]=${ord}`
  const r = await kommoFetch(env, `/api/v4/leads/${lid}/notes?${q}`)
  if (!r.ok) {
    return {
      ok: false,
      code: r.code || 'KOMMO_ERROR',
      status: r.status,
      error: summarizeError(r),
      notes: [],
    }
  }
  const notes = r.data?._embedded?.notes || []
  return { ok: true, notes, status: r.status }
}

/**
 * IDs de contatos ligados ao lead (embed `contacts` + `main_contact_id`).
 * @returns { Promise<number[]> }
 */
export async function getLeadContactIds(env, leadId) {
  const lid = Number(leadId)
  if (!Number.isFinite(lid) || lid <= 0) return []
  const r = await kommoFetch(env, `/api/v4/leads/${lid}?with=contacts`)
  if (!r.ok) return []
  const lead = r.data
  const out = []
  const main = Number(lead?.main_contact_id)
  if (Number.isFinite(main) && main > 0) out.push(main)
  const embedded = lead?._embedded?.contacts || []
  for (const c of embedded) {
    const id = Number(c?.id)
    if (Number.isFinite(id) && id > 0) out.push(id)
  }
  return [...new Set(out)]
}

/**
 * Tenta listar talks vinculados ao lead (para obter chat_id → histórico Amojo).
 * Inclui talks com entity_id = lead OU = contato(s) do lead (WhatsApp costuma
 * ficar no contato).
 *
 * @returns { ok, talks: object[], error? }
 */
export async function tryListTalksForLead(env, leadId) {
  const lid = Number(leadId)
  if (!Number.isFinite(lid) || lid <= 0) {
    return { ok: false, error: 'leadId inválido', talks: [] }
  }
  const contactIds = await getLeadContactIds(env, lid)
  const acceptable = new Set([lid, ...contactIds])

  const leadPaths = [
    `/api/v4/talks?limit=50&filter[entity_id][0]=${lid}&filter[entity_type][0]=lead`,
    `/api/v4/talks?limit=50&filter[entity_id][0]=${lid}`,
    `/api/v4/talks?limit=50&filter[entity_id]=${lid}`,
  ]
  const contactPaths = []
  for (const cid of contactIds.slice(0, 8)) {
    contactPaths.push(`/api/v4/talks?limit=50&filter[entity_id][0]=${cid}&filter[entity_type][0]=contact`)
    contactPaths.push(`/api/v4/talks?limit=50&filter[entity_id][0]=${cid}`)
  }

  const byId = new Map()
  const ingest = (talks) => {
    if (!Array.isArray(talks)) return
    for (const t of talks) {
      const eid = Number(t?.entity_id)
      if (!acceptable.has(eid)) continue
      const id = t?.id ?? t?.talk_id
      if (id == null || id === '') continue
      const key = String(id)
      if (!byId.has(key)) byId.set(key, t)
    }
  }

  for (const path of [...leadPaths, ...contactPaths]) {
    const r = await kommoFetch(env, path)
    if (!r.ok) continue
    ingest(r.data?._embedded?.talks || [])
  }

  const talks = [...byId.values()]
  if (talks.length === 0) {
    console.warn(
      `[kommoClient] tryListTalksForLead lead=${lid}: nenhum talk com entity_id em {lead, contatos}=` +
        `${[...acceptable].join(',')}. contactIds=${contactIds.join(',') || 'nenhum'}`,
    )
  }
  return { ok: true, talks }
}

/**
 * Chats (chat_id da Chats API) ligados a um contato — REST v4.
 * @see https://developers.kommo.com/reference/get-contact-chats
 * @returns { Promise<{ ok: boolean, chats: any[], status?: number, error?: string }> }
 */
export async function listContactChats(env, contactId) {
  const cid = Number(contactId)
  if (!Number.isFinite(cid) || cid <= 0) {
    return { ok: false, error: 'contactId inválido', chats: [] }
  }
  const r = await kommoFetch(env, `/api/v4/contacts/chats?contact_id=${cid}`)
  if (!r.ok) {
    return { ok: false, status: r.status, error: summarizeError(r), chats: [] }
  }
  if (r.status === 204) return { ok: true, chats: [], status: 204 }
  const chats = r.data?._embedded?.chats || []
  return { ok: true, chats, status: r.status }
}

// Cache de mapeamento "nome do campo" → field_id (em memória, por
// processo). Os custom fields do Kommo raramente mudam, então 5min
// de TTL é suficiente para evitar listar a cada chamada de tool.
let _leadCustomFieldsCache = { ts: 0, byName: null, raw: null }
const LEAD_FIELDS_TTL_MS = 5 * 60 * 1000

/**
 * Lista todos os custom fields do tipo "lead" no Kommo (paginado).
 * Retorna `{ ok, byName: Map<lowerName, fieldDef>, raw: [...] }` onde
 * `byName` permite descobrir o `field_id` por nome (case-insensitive).
 *
 * Cache em memória (TTL 5min). Use `force=true` p/ recarregar.
 */
export async function listLeadCustomFields(env, { force = false } = {}) {
  const now = Date.now()
  if (
    !force &&
    _leadCustomFieldsCache.byName &&
    now - _leadCustomFieldsCache.ts < LEAD_FIELDS_TTL_MS
  ) {
    return { ok: true, byName: _leadCustomFieldsCache.byName, raw: _leadCustomFieldsCache.raw, cached: true }
  }
  const all = []
  let page = 1
  const limit = 250
  for (let safety = 0; safety < 20; safety += 1) {
    const r = await kommoFetch(env, `/api/v4/leads/custom_fields?page=${page}&limit=${limit}`)
    if (!r.ok) {
      // 204 = sem conteúdo (fim da paginação) — Kommo retorna isso
      // quando a página passa do total.
      if (r.status === 204) break
      return { ok: false, status: r.status, error: summarizeError(r) }
    }
    const items = r.data?._embedded?.custom_fields || []
    if (!items.length) break
    all.push(...items)
    if (items.length < limit) break
    page += 1
  }
  const byName = new Map()
  for (const f of all) {
    if (f?.name && Number.isFinite(Number(f.id))) {
      byName.set(String(f.name).trim().toLowerCase(), {
        id: Number(f.id),
        type: f.type,
        name: f.name,
        enums: f.enums || null,
      })
    }
  }
  _leadCustomFieldsCache = { ts: now, byName, raw: all }
  return { ok: true, byName, raw: all, cached: false }
}

/**
 * Resolve o `field_id` por nome (case-insensitive). Retorna `null` se
 * não encontrar. Aceita uma lista de aliases — o primeiro que bater é
 * retornado. Útil quando o Kommo pode ter o campo nomeado de várias
 * formas ("Curso Inscrição" / "Curso da Inscrição").
 */
export async function resolveLeadFieldIdByName(env, names) {
  const r = await listLeadCustomFields(env)
  if (!r.ok) return null
  const list = Array.isArray(names) ? names : [names]
  for (const n of list) {
    const def = r.byName.get(String(n).trim().toLowerCase())
    if (def) return def
  }
  return null
}

/**
 * Detalhe de uma conversa (inclui chat_id).
 *
 * @returns { ok, talk?, error? }
 */
export async function getTalkById(env, talkId) {
  const raw = talkId != null ? String(talkId).trim() : ''
  if (!raw) {
    return { ok: false, error: 'talkId inválido' }
  }
  const segment = encodeURIComponent(raw)
  const r = await kommoFetch(env, `/api/v4/talks/${segment}`)
  if (!r.ok) {
    return { ok: false, status: r.status, error: summarizeError(r) }
  }
  return { ok: true, talk: r.data }
}

/**
 * Lista eventos do log do Kommo associados a um lead.
 *
 * Útil para capturar mensagens recebidas (`incoming_chat_message`) sem depender
 * de notas — a maioria das integrações de WhatsApp/Chats API publica esses
 * eventos no log nativo do Kommo, mesmo quando não cria uma nota visível.
 *
 * Endpoint: GET /api/v4/events
 * Filtros suportados:
 *   - filter[type][n]=<event_type>  (incoming_chat_message, outgoing_chat_message, ...)
 *   - filter[entity]=lead | contact
 *   - filter[entity_id][0]=<id>
 *   - filter[created_at][from]=<unix_seconds>
 *
 * Observação: NÃO usar with=value_after,value_before — o Kommo rejeita com 400
 * "Invalid with parameter given". Os campos value_after/value_before já vêm
 * por padrão no objeto do evento quando aplicáveis.
 *
 * @param {Record<string,string>} env
 * @param {number|string} leadId
 * @param {{ types?: string[], fromTs?: number, limit?: number, entity?: 'lead'|'contact', entityId?: number|string }} [opts]
 * @returns {Promise<{ ok: boolean, events: any[], status?: number, error?: string, requestUrl?: string }>}
 */
/** Tipos que o endpoint GET /api/v4/events rejeita em filter[type] (400 Invalid params). */
const KOMMO_EVENTS_UNSUPPORTED_FILTER_TYPES = new Set(['incoming_message'])

export async function listLeadEvents(env, leadId, opts = {}) {
  const lid = Number(leadId)
  const entityIdRaw = opts.entityId != null ? Number(opts.entityId) : lid
  if (!Number.isFinite(entityIdRaw) || entityIdRaw <= 0) {
    return { ok: false, code: 'MISSING_LEAD_ID', error: 'leadId/entityId inválido', events: [] }
  }
  const entity = String(opts.entity || 'lead').trim().toLowerCase() === 'contact' ? 'contact' : 'lead'
  // types vazio (array vazio) = sem filtro de tipo
  let typesArr = Array.isArray(opts.types)
    ? opts.types.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    : ['incoming_chat_message']
  if (typesArr.length > 0) {
    const dropped = typesArr.filter((t) => KOMMO_EVENTS_UNSUPPORTED_FILTER_TYPES.has(t))
    if (dropped.length) {
      console.warn(
        `[kommoClient] listLeadEvents: ignorando tipo(s) não aceitos em filter[type] (Kommo 400): ${dropped.join(', ')}`,
      )
    }
    typesArr = typesArr.filter((t) => !KOMMO_EVENTS_UNSUPPORTED_FILTER_TYPES.has(t))
    if (typesArr.length === 0) {
      typesArr = ['incoming_chat_message']
    }
  }
  const limit = Math.min(250, Math.max(1, Number(opts.limit) || 50))
  const fromTs = Number(opts.fromTs) > 0 ? Math.floor(Number(opts.fromTs)) : 0

  const params = []
  typesArr.forEach((t, i) => {
    params.push(`filter[type][${i}]=${encodeURIComponent(t)}`)
  })
  params.push(`filter[entity]=${entity}`)
  params.push(`filter[entity_id][0]=${entityIdRaw}`)
  if (fromTs > 0) {
    params.push(`filter[created_at][from]=${fromTs}`)
  }
  params.push(`limit=${limit}`)

  const path = `/api/v4/events?${params.join('&')}`
  const r = await kommoFetch(env, path)
  if (!r.ok) {
    if (r.status === 204) return { ok: true, events: [], status: 204, requestUrl: path }
    return {
      ok: false,
      code: r.code || 'KOMMO_ERROR',
      status: r.status,
      error: summarizeError(r),
      events: [],
      requestUrl: path,
    }
  }
  const events = r.data?._embedded?.events || []
  return { ok: true, events, status: r.status, requestUrl: path }
}

/**
 * Move o lead para outro estágio do funil (pipeline + status).
 *
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function updateLeadPipelineStatus(env, leadId, { pipelineId, statusId }) {
  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, code: 'MISSING_LEAD_ID', error: 'leadId inválido' }
  }
  const pip = Number(pipelineId)
  const st = Number(statusId)
  if (!Number.isFinite(pip) || pip <= 0 || !Number.isFinite(st) || st <= 0) {
    return { ok: false, code: 'MISSING_PIPELINE_STATUS', error: 'pipelineId/statusId inválidos' }
  }
  const r = await kommoFetch(env, `/api/v4/leads/${id}`, {
    method: 'PATCH',
    body: { pipeline_id: pip, status_id: st },
  })
  if (!r.ok) {
    return { ok: false, code: r.code || 'KOMMO_ERROR', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, status: r.status }
}
