/**
 * Diagnóstico rápido de lead — Kommo + Supabase + histórico.
 * Uso: node --env-file=.env scripts/investigate-lead.mjs <leadId>
 */
import { listLeadNotes } from '../server/kommoClient.js'
import { fetchLeadFormSnapshot, validateFormSnapshot } from '../server/inscricaoKommoFields.js'
import { isSumareCaptacaoEnabled } from '../server/sumareCaptacaoClient.js'
import { messageLooksLikeFormSumarResponse } from '../libShared/inscricaoFormHeuristics.js'

const env = process.env
const leadId = Number(process.argv[2])
if (!Number.isFinite(leadId) || leadId <= 0) {
  console.error('Uso: node --env-file=.env scripts/investigate-lead.mjs <leadId>')
  process.exit(1)
}

const base = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
const token = env.KOMMO_ACCESS_TOKEN || ''
const supUrl = (env.SUPABASE_URL || '').replace(/\/$/, '')
const supKey = env.SUPABASE_KEY || ''
const table = env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum'
const chatTable = env.SUPABASE_CHAT_MESSAGES_TABLE || 'chat_messages_sum'

async function kommoGet(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  })
  const data = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, data }
}

function noteText(n) {
  return [n?.params?.text, n?.params?.message, n?.text].filter(Boolean).join(' ').trim()
}

const out = { leadId, timestamp: new Date().toISOString() }

const leadRes = await kommoGet(`/api/v4/leads/${leadId}?with=contacts`)
if (!leadRes.ok) {
  out.kommoError = leadRes.status
  console.log(JSON.stringify(out, null, 2))
  process.exit(1)
}
const lead = leadRes.data
const contact = lead?._embedded?.contacts?.[0]
const phones = (contact?.custom_fields_values || [])
  .filter((f) => /phone|telefone/i.test(String(f.field_code || f.field_name || '')))
  .flatMap((f) => (f.values || []).map((v) => v.value))
out.kommo = {
  name: lead?.name,
  pipeline_id: lead?.pipeline_id,
  status_id: lead?.status_id,
  created_at: lead?.created_at,
  updated_at: lead?.updated_at,
  phones: phones.length ? phones : contact?.custom_fields_values?.[0]?.values?.[0]?.value,
}

const notesRes = await listLeadNotes(env, leadId, { limit: 40, order: 'desc' })
const notes = (notesRes.notes || []).map((n) => {
  const t = noteText(n)
  return {
    id: n.id,
    created_at: n.created_at || n.date_create,
    note_type: n.note_type,
    text: t.slice(0, 500),
    isForm: messageLooksLikeFormSumarResponse(t),
    fromAgent: /\s-\s+EX-\d{6}-\d{4}-\d{3}\s*$/i.test(t),
  }
})
out.notesRecent = notes.slice(0, 25)
out.formNotes = notes.filter((n) => n.isForm)
out.lastInbound = notes.find((n) => !n.fromAgent && n.text)

const snap = await fetchLeadFormSnapshot(env, leadId)
if (snap.ok) {
  const val = validateFormSnapshot(env, snap.snapshot)
  out.formSnapshot = snap.snapshot
  out.formValidation = val
}

out.captacao = {
  enabled: isSumareCaptacaoEnabled(env),
  tokenConfigured: Boolean(String(env.SUMARE_CAPTACAO_TOKEN || '').trim()),
}

if (supUrl && supKey) {
  const tel = String(out.kommo.phones || '').replace(/\D/g, '')
  if (tel) {
    const qTel = `${supUrl}/rest/v1/${encodeURIComponent(table)}?or=(telefone.eq.${encodeURIComponent(tel)},telefone.eq.${encodeURIComponent(tel + '@s.whatsapp.net')})&select=telefone,inscricao_form_status,inscricao_form_recebido_at,atendimento_ia&limit=1`
    const r1 = await fetch(qTel, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } })
    out.dadosCliente = r1.ok ? (await r1.json())?.[0] || null : { error: r1.status }
  } else {
    out.dadosCliente = { error: 'no_phone_on_lead' }
  }

  if (tel) {
    const qChat = `${supUrl}/rest/v1/${encodeURIComponent(chatTable)}?telefone=eq.${tel}&order=created_at.desc&limit=15&select=role,content,created_at`
    const r2 = await fetch(qChat, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } })
    if (r2.ok) {
      out.chatRecent = (await r2.json()).map((m) => ({
        role: m.role,
        at: m.created_at,
        text: String(m.content || '').slice(0, 280),
      }))
    }
  }
}

console.log(JSON.stringify(out, null, 2))
