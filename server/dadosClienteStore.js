/**
 * Store para a tabela `dados_cliente` no Supabase principal (banco da IA).
 *
 * Espelha os nodes "Supabase update" que o N8N usa para gravar estado do lead
 * (teste A/B, id_lead no Kommo, atendimento_ia, etc.).
 *
 * Primeiro node implementado aqui:
 *
 *   UPDATE dados_cliente
 *   SET teste_AB = 'IA',
 *       id_lead  = <id retornado do Kommo>
 *   WHERE telefone = <telefoneCorreto>
 *
 * Env necessárias (reutiliza o banco principal):
 *   SUPABASE_URL  (ou VITE_SUPABASE_URL)
 *   SUPABASE_KEY  (ou VITE_SUPABASE_KEY)
 */

/** Tira máscara, @s.whatsapp.net, espaços — deixa só dígitos. */
export function normalizeTelefone(input) {
  if (input == null) return ''
  const raw = String(input).split('@')[0]
  return raw.replace(/[^0-9]/g, '')
}

/** JID WhatsApp usado em várias linhas de `dados_cliente_sum`. */
export function telefoneToWhatsAppJid(digits) {
  const d = normalizeTelefone(digits)
  return d ? `${d}@s.whatsapp.net` : ''
}

/**
 * Filtro PostgREST: telefone no banco pode estar só com dígitos ou com @s.whatsapp.net.
 */
export function dadosClienteTelefoneOrFilter(telefone) {
  const digits = normalizeTelefone(telefone)
  if (!digits) return null
  const jid = telefoneToWhatsAppJid(digits)
  return `or=(telefone.eq.${encodeURIComponent(digits)},telefone.eq.${encodeURIComponent(jid)})`
}

export async function fetchDadosClienteByTelefone(env, telefone, select = '*') {
  const filter = dadosClienteTelefoneOrFilter(telefone)
  if (!filter) return null
  const { url, key, table } = getConfig(env)
  if (!url || !key) return null
  try {
    const { ok, data } = await supabaseGet(url, key, `${table}?${filter}&select=${select}&limit=1`)
    if (!ok || !Array.isArray(data) || !data.length) return null
    return data[0]
  } catch {
    return null
  }
}

/** IA pausada após form/handoff — o flush do WhatsApp não deve chamar o orquestrador. */
export async function isAtendimentoIaPaused(env, telefone) {
  const row = await fetchDadosClienteByTelefone(env, telefone, 'atendimento_ia')
  return String(row?.atendimento_ia || '').toLowerCase() === 'pause'
}

function getConfig(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL || ''
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
  const table = env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum'
  return { url: url.replace(/\/$/, ''), key, table }
}

async function supabaseGet(url, key, pathAndQuery) {
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    method: 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data, raw: text }
}

async function supabasePatch(url, key, pathAndQuery, body) {
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data, raw: text }
}

/**
 * UPDATE genérico em dados_cliente filtrado por telefone.
 * Retorna a lista de linhas afetadas (Supabase `return=representation`).
 *
 * @param {Record<string,string>} env
 * @param {object} params
 * @param {string} params.telefone  telefone normalizado (só dígitos) ou JID
 * @param {Record<string, any>} params.fields  colunas → valores a atualizar
 */
export async function updateDadosCliente(env, { telefone, fields }) {
  const { url, key, table } = getConfig(env)
  if (!url || !key) {
    return { ok: false, code: 'SUPABASE_NOT_CONFIGURED', error: 'Configure SUPABASE_URL e SUPABASE_KEY.' }
  }
  const fone = normalizeTelefone(telefone)
  if (!fone) {
    return { ok: false, code: 'MISSING_TELEFONE', error: 'Informe um telefone válido.' }
  }
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    return { ok: false, code: 'MISSING_FIELDS', error: 'Informe ao menos um campo para atualizar.' }
  }

  const telFilter = dadosClienteTelefoneOrFilter(fone)
  if (!telFilter) {
    return { ok: false, code: 'MISSING_TELEFONE', error: 'Informe um telefone válido.' }
  }
  const { ok, status, data, raw } = await supabasePatch(url, key, `${table}?${telFilter}`, fields)
  if (!ok) {
    return {
      ok: false,
      code: 'SUPABASE_UPDATE_FAILED',
      status,
      error: typeof raw === 'string' ? raw.slice(0, 500) : 'erro desconhecido',
    }
  }
  const rows = Array.isArray(data) ? data : []
  return {
    ok: true,
    table,
    telefone: fone,
    updated: rows.length,
    fields,
    rows,
    matched: rows.length > 0,
  }
}

/**
 * Node "Atualizar Cliente" — marca teste A/B = IA + grava id do lead do Kommo.
 *
 * @param {Record<string,string>} env
 * @param {object} params
 * @param {string} params.telefone  telefone do lead (JID ou só dígitos)
 * @param {number|string} params.idLead  id retornado pelo Kommo
 */
export async function marcarClienteIA(env, { telefone, idLead }) {
  if (idLead == null || idLead === '') {
    return { ok: false, code: 'MISSING_ID_LEAD', error: 'Informe id_lead (id retornado do Kommo).' }
  }
  const idLeadNum = Number(idLead)
  const idLeadValue = Number.isFinite(idLeadNum) ? idLeadNum : String(idLead)

  return updateDadosCliente(env, {
    telefone,
    fields: {
      teste_AB: 'IA',
      id_lead: idLeadValue,
    },
  })
}

/**
 * Busca o id_lead gravado em dados_cliente para um telefone.
 * Retorna um número, string ou null. Nunca lança — em qualquer erro devolve null.
 */
export async function getLeadIdByTelefone(env, telefone) {
  try {
    const { url, key, table } = getConfig(env)
    if (!url || !key) return null
    const row = await fetchDadosClienteByTelefone(env, telefone, 'id_lead')
    if (!row) return null
    const raw = row.id_lead
    if (raw == null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  } catch {
    return null
  }
}
