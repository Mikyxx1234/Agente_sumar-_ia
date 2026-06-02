import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('='); const k = line.slice(0, i).trim(); if (!env[k]) env[k] = line.slice(i + 1).trim()
}

const KBASE = (env.KOMMO_BASE_URL || env.KOMMO_API_URL || '').replace(/\/$/, '')
const KTOK = env.KOMMO_ACCESS_TOKEN || env.KOMMO_TOKEN || ''
const U = env.SUPABASE_URL
const K = env.SUPABASE_KEY
const H = { apikey: K, Authorization: 'Bearer ' + K }

const PIPELINE = 13756724
const STATUSES = [
  { id: 106140284, name: 'Atendimento' },
  { id: 106804680, name: 'inscrição' },
]

const kget = async (p) => {
  const r = await fetch(`${KBASE}/api/v4/${p}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${KTOK}` } })
  if (r.status === 204) return { _embedded: { leads: [] } }
  const t = await r.text(); try { return JSON.parse(t) } catch { return { _raw: t, _status: r.status } }
}
const sget = async (q) => {
  const r = await fetch(`${U}/rest/v1/${q}`, { headers: H })
  const t = await r.text(); try { return JSON.parse(t) } catch { return t }
}

const digits = (v) => String(v || '').replace(/\D/g, '')
const normPhone = (v) => {
  let d = digits(v); if (!d) return null
  if (!d.startsWith('55') && (d.length === 10 || d.length === 11)) d = '55' + d
  return d
}
const phoneFromContact = (c) => {
  for (const f of c?.custom_fields_values || []) {
    if (f.field_code === 'PHONE' || /phone|telefone|whats/i.test(f.field_name || '')) {
      for (const v of f.values || []) { const p = normPhone(v.value); if (p) return p }
    }
  }
  return null
}

// 1) leads na fila do agente
let leads = []
for (const st of STATUSES) {
  let page = 1
  for (;;) {
    const data = await kget(`leads?filter[statuses][0][pipeline_id]=${PIPELINE}&filter[statuses][0][status_id]=${st.id}&with=contacts&limit=250&page=${page}`)
    const arr = data?._embedded?.leads || []
    for (const l of arr) leads.push({ ...l, _statusName: st.name })
    if (arr.length < 250) break
    page++
  }
}
console.log(`\n=== VISTORIA — fila do agente (pipeline ${PIPELINE}) ===`)
console.log(`Atendimento+inscrição: ${leads.length} lead(s)\n`)

// 2) bulk contatos
const contactIds = [...new Set(leads.flatMap((l) => (l?._embedded?.contacts || []).map((c) => Number(c.id))).filter(Boolean))]
const contactById = new Map()
for (let i = 0; i < contactIds.length; i += 200) {
  const chunk = contactIds.slice(i, i + 200)
  const q = chunk.map((id, j) => `filter[id][${j}]=${id}`).join('&')
  const data = await kget(`contacts?${q}&limit=250`)
  for (const c of data?._embedded?.contacts || []) contactById.set(Number(c.id), c)
}

const issues = []
for (const lead of leads) {
  const cs = lead?._embedded?.contacts || []
  let phone = null
  for (const c of cs) { const d = contactById.get(Number(c.id)); if (d) { phone = phoneFromContact(d); if (phone) break } }
  const sid = phone ? `${phone}@s.whatsapp.net` : null

  let estado = null, bufN = 0, lastMem = [], estadoKeys = []
  if (sid) {
    const nat = phone.replace(/^55/, '') // casa com e sem prefixo 55
    const d = await sget(`dados_cliente_sum?telefone=ilike.*${nat}*&select=telefone,atendimento_ia,inscricao_form_status,kommo_curso`)
    if (Array.isArray(d) && d.length) { estado = d[0]; estadoKeys = d.map((x) => x.telefone) }
    const b = await sget(`message_buffer?session_id=eq.${encodeURIComponent(sid)}&select=content`)
    bufN = Array.isArray(b) ? b.length : 0
    const h = await sget(`n8n_chat_histories?session_id=eq.${encodeURIComponent(sid)}&select=id,message&order=id.desc&limit=2`)
    if (Array.isArray(h)) lastMem = h.reverse().map((x) => { const m = x.message?.data || x.message || {}; return `${m.type || '?'}:${String(m.content || '').replace(/\s+/g, ' ').slice(0, 50)}` })
  }

  const flags = []
  if (!phone) flags.push('SEM_TELEFONE')
  if (estado?.atendimento_ia && /pause|pausa|off|desativ/i.test(estado.atendimento_ia)) flags.push(`IA_PAUSADA(${estado.atendimento_ia})`)
  if (bufN > 0) flags.push(`BUFFER_PENDENTE(${bufN})`)
  const keyMismatch = sid && estadoKeys.length && !estadoKeys.includes(sid)
  if (keyMismatch) flags.push(`CHAVE_DIVERGENTE(${estadoKeys.join('|')})`)
  if (flags.length) issues.push({ id: lead.id, name: lead.name, flags })

  console.log(`#${lead.id} [${lead._statusName}] ${String(lead.name || '').slice(0, 28).padEnd(28)} tel=${phone || '—'} ia=${estado?.atendimento_ia ?? '—'} form=${estado?.inscricao_form_status ?? '—'} buf=${bufN} ${flags.length ? '⚠ ' + flags.join(',') : 'OK'}`)
  if (lastMem.length) console.log(`     mem: ${lastMem.join(' | ')}`)
}

console.log('\n=== RESUMO ===')
if (!issues.length) console.log('Nenhum problema detectado — todos os leads na fila estão atendíveis.')
else { console.log(`${issues.length} lead(s) com alerta:`); for (const it of issues) console.log(`  #${it.id} ${it.name}: ${it.flags.join(', ')}`) }
