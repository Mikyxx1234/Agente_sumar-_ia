/**
 * Diagnóstico do agente em produção:
 *  1. Lista leads no funil do agente (pipeline/status do KOMMO_AGENT_*).
 *  2. Para cada lead: telefone, status no dados_cliente_sum (atendimento_ia,
 *     inscricao_form_status), última msg do cliente, última resposta do bot.
 *  3. Mostra envs críticas + sinaliza leads com mensagens recentes sem resposta.
 *
 * Uso: node scripts/diag-agente.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { listLeadsInAgentQueue } from '../server/kommoAgentFunnel.js'
import {
  bulkGetContactsByIds,
  extractContactPhone,
  extractLeadPhone,
  listLeadNotes,
} from '../server/kommoClient.js'
import { fetchDadosClienteByTelefone } from '../server/dadosClienteStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

function loadEnv() {
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!k || process.env[k]) continue
    process.env[k] = line.slice(i + 1)
  }
}
loadEnv()

const env = process.env

console.log('\n=== Envs críticas ===')
console.log({
  KOMMO_AGENT_PIPELINE_ID: env.KOMMO_AGENT_PIPELINE_ID,
  KOMMO_AGENT_STATUS_ID: env.KOMMO_AGENT_STATUS_ID,
  KOMMO_SCHEDULER_ENABLED: env.KOMMO_SCHEDULER_ENABLED ?? '(default true)',
  KOMMO_INBOUND_POLL_ENABLED: env.KOMMO_INBOUND_POLL_ENABLED ?? '(default false)',
  KOMMO_INBOUND_POLL_MODE: env.KOMMO_INBOUND_POLL_MODE ?? '(default)',
  KOMMO_SCHEDULER_INTERVAL_SEC: env.KOMMO_SCHEDULER_INTERVAL_SEC ?? '30',
  KOMMO_SCHEDULER_DEBOUNCE_SEC: env.KOMMO_SCHEDULER_DEBOUNCE_SEC ?? '15',
  INSCRICAO_DESISTENCIA_ENABLED: env.INSCRICAO_DESISTENCIA_ENABLED ?? '(default true)',
  INSCRICAO_KOMMO_CARD_EXPRESS_ENABLED: env.INSCRICAO_KOMMO_CARD_EXPRESS_ENABLED ?? '(default true)',
})

console.log('\n=== Leads no funil do agente ===')
const leads = await listLeadsInAgentQueue(env).catch((e) => ({ ok: false, error: e.message }))
if (!leads.ok) {
  console.error('  erro:', leads.error || leads.status, leads.code || '')
  process.exit(1)
}
console.log(`  total=${leads.leads?.length || 0}`)

const sample = (leads.leads || []).slice(0, 20)
const contactIds = []
for (const l of sample) {
  for (const c of l?._embedded?.contacts || []) {
    if (Number.isFinite(Number(c?.id))) contactIds.push(Number(c.id))
  }
}
const bulk = contactIds.length ? await bulkGetContactsByIds(env, contactIds) : { ok: true, contacts: [] }
const contactMap = new Map()
for (const c of bulk.contacts || []) contactMap.set(Number(c?.id), c)

for (const l of sample) {
  let phone = extractLeadPhone(l)
  if (!phone) {
    for (const c of l?._embedded?.contacts || []) {
      const co = contactMap.get(Number(c?.id))
      if (co) {
        const p = extractContactPhone(co)
        if (p) {
          phone = p
          break
        }
      }
    }
  }
  const row = phone
    ? await fetchDadosClienteByTelefone(env, phone, 'atendimento_ia,inscricao_form_status').catch(() => null)
    : null
  const ageSec = l?.updated_at ? Math.round((Date.now() / 1000) - Number(l.updated_at)) : null
  console.log(
    `  lead=${l.id} ${l.name?.slice(0, 30) || '(sem nome)'} ` +
      `phone=${phone || '(sem phone)'} ` +
      `ia=${row?.atendimento_ia ?? 'null'} form=${row?.inscricao_form_status ?? 'null'} ` +
      `updated=${ageSec}s atrás`,
  )
}

console.log('\n=== Buffer Redis / Supabase message_buffer (sessões com pendência) ===')
const sup = (env.SUPABASE_URL || '').replace(/\/$/, '')
const key = env.SUPABASE_KEY || ''
const bufTable = env.MESSAGE_BUFFER_TABLE || 'message_buffer'
const ru = await fetch(
  `${sup}/rest/v1/${encodeURIComponent(bufTable)}?select=session_id,created_at,texto&order=created_at.desc&limit=10`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
).catch(() => null)
const buf = ru ? await ru.json().catch(() => null) : null
if (!buf || !Array.isArray(buf)) {
  console.log('  (Supabase message_buffer indisponível — pode estar no Redis)')
} else if (buf.length === 0) {
  console.log('  (nenhuma mensagem pendente)')
} else {
  for (const b of buf) {
    const ageS = Math.round((Date.now() - new Date(b.created_at).getTime()) / 1000)
    console.log(`  session=${b.session_id} age=${ageS}s msg="${String(b.texto || '').slice(0, 80)}"`)
  }
}

for (const leadId of [23608285, 23841399]) {
  console.log(`\n=== Últimas 12 notas do lead #${leadId} ===`)
  const r = await listLeadNotes(env, leadId, { limit: 30, order: 'desc' }).catch((e) => ({ ok: false, error: e?.message }))
  const items = r?.notes || []
  if (!items.length) {
    console.log('  (sem notas)' + (r?.error ? ` erro=${r.error}` : ''))
    continue
  }
  for (const n of items.slice(0, 12)) {
    const ts = n.updated_at || n.created_at
    const date = ts ? new Date(ts * 1000).toISOString().slice(0, 19) : 'n/a'
    const text = n?.params?.text || n?.params?.service || n?.text || JSON.stringify(n?.params || {}).slice(0, 80)
    const auth = n.created_by === 0 ? 'system' : `user#${n.created_by}`
    console.log(`  ${date} [type=${n.note_type}] [auth=${auth}] "${String(text).slice(0, 130).replace(/\n/g, ' | ')}"`)
  }
}

// Histórico Supabase (n8n_chat_histories) do William
console.log('\n=== n8n_chat_histories — sessão 5511944690752 (William) ===')
const session = '5511944690752@s.whatsapp.net'
const ru2 = await fetch(
  `${sup}/rest/v1/${encodeURIComponent(env.N8N_MEMORY_TABLE || 'n8n_chat_histories')}?session_id=eq.${encodeURIComponent(session)}&select=id,message&order=id.desc&limit=12`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
)
const n8n = await ru2.json().catch(() => null)
if (!Array.isArray(n8n) || n8n.length === 0) {
  console.log('  (histórico vazio)')
} else {
  for (const row of [...n8n].reverse()) {
    const m = row.message || {}
    const role = m.type === 'human' ? 'user' : m.type === 'ai' ? 'assistant' : m.type
    const content = (m.content || m?.data?.content || '').slice(0, 130).replace(/\n/g, ' | ')
    console.log(`  [id=${row.id}] [${role}] "${content}"`)
  }
}
