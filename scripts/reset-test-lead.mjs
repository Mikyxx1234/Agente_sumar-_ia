/**
 * Reset de lead de teste no Supabase (histórico + estado do fluxo).
 * Uso: node scripts/reset-test-lead.mjs [telefone] [id_lead]
 *      node scripts/reset-test-lead.mjs --lead 23841399
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { updateDadosCliente, telefoneToWhatsAppJid } from '../server/dadosClienteStore.js'
import { clearAgentConversationMemory } from '../server/historyStore.js'
import { getLeadSummary } from '../server/kommoClient.js'
import { resetKommoInboundPollStateForLead } from '../server/kommoInboundPoll.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

function loadEnv() {
  const env = { ...process.env }
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return env
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!k || env[k]) continue
    env[k] = line.slice(i + 1)
  }
  return env
}

function normalizeTelefone(input) {
  if (input == null) return ''
  return String(input).split('@')[0].replace(/[^0-9]/g, '')
}

async function sb(env, method, table, query, body) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || ''
  const pathQ = `${encodeURIComponent(table)}?${query}`
  const res = await fetch(`${url}/rest/v1/${pathQ}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json', Prefer: 'return=representation' } : { Prefer: 'count=exact' }),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { ok: res.ok, status: res.status, data, range: res.headers.get('content-range') }
}

async function resolveTelefoneAndLead(env, telefoneArg, leadIdArg) {
  let telefone = normalizeTelefone(telefoneArg)
  let idLead = String(leadIdArg || '').trim()

  if (telefoneArg === '--lead' || (!telefone && idLead)) {
    idLead = String(leadIdArg || telefoneArg).trim()
    telefone = ''
  }

  if (!telefone && idLead) {
    const summary = await getLeadSummary(env, Number(idLead))
    if (summary.ok && summary.phone) {
      telefone = normalizeTelefone(summary.phone)
      console.log(`Telefone resolvido via Kommo lead=${idLead}: ${telefone}`)
    }
  }

  if (!telefone) {
    telefone = normalizeTelefone('5511944690752')
  }
  if (!idLead) {
    idLead = '23833445'
  }

  return { telefone, idLead }
}

async function main() {
  const env = loadEnv()
  const arg1 = process.argv[2]
  const arg2 = process.argv[3]

  let telefoneArg = arg1
  let leadIdArg = arg2
  if (arg1 === '--lead') {
    telefoneArg = ''
    leadIdArg = arg2
  }

  const { telefone, idLead } = await resolveTelefoneAndLead(env, telefoneArg, leadIdArg)
  // O backend usa JID com DDI Brasil (55 + DDD + número), gerado por
  // `phoneToWhatsAppSessionId`. Reset que ignora o DDI deixa órfãos.
  const sessionIdCanonical = phoneToWhatsAppSessionId(telefone) || `${telefone}@s.whatsapp.net`
  const sessionIdLegacy = `${telefone}@s.whatsapp.net`
  const jid = sessionIdCanonical

  const memoryTable = env.N8N_MEMORY_TABLE || 'n8n_chat_histories'
  const messagesTable = env.SUPABASE_CHAT_MESSAGES_TABLE || 'chat_messages_sum'
  const chatsTable = env.SUPABASE_CHATS_TABLE || 'chats_sum'
  const dadosTable = env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum'
  const bufferTable = env.MESSAGE_BUFFER_TABLE || 'message_buffer'

  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    console.error('SUPABASE_URL e SUPABASE_KEY são obrigatórios (env ou .env).')
    process.exit(1)
  }

  console.log('Reset lead teste:', {
    telefone,
    idLead,
    sessionIdCanonical,
    sessionIdLegacy,
    dadosTable,
    messagesTable,
    memoryTable,
  })

  const results = []
  // Telefone pode estar gravado como dígitos puros OU como JID — em duas
  // formas: com DDI 55 (canônico) e sem DDI (legado).
  const telefoneCanonical = sessionIdCanonical.split('@')[0]
  const phoneOr =
    `or=(phone.eq.${encodeURIComponent(telefone)}` +
    `,phone.eq.${encodeURIComponent(telefoneCanonical)}` +
    `,phone.eq.${encodeURIComponent(sessionIdCanonical)}` +
    `,phone.eq.${encodeURIComponent(sessionIdLegacy)})`
  const telefoneMensagensIa =
    `or=(usage->>telefone.eq.${encodeURIComponent(telefone)}` +
    `,usage->>telefone.eq.${encodeURIComponent(telefoneCanonical)})`

  for (const [table, q] of [
    [memoryTable, `session_id=eq.${encodeURIComponent(sessionIdCanonical)}`],
    [memoryTable, `session_id=eq.${encodeURIComponent(sessionIdLegacy)}`],
    [messagesTable, phoneOr],
    [messagesTable, `id_lead=eq.${encodeURIComponent(idLead)}`],
    [chatsTable, `phone=eq.${telefoneCanonical}`],
    [chatsTable, `phone=eq.${telefone}`],
    [chatsTable, `phone=eq.${encodeURIComponent(sessionIdCanonical)}`],
    [bufferTable, `session_id=eq.${encodeURIComponent(sessionIdCanonical)}`],
    [bufferTable, `session_id=eq.${encodeURIComponent(sessionIdLegacy)}`],
    ['mensagens_ia', `usage->>lead_id=eq.${encodeURIComponent(idLead)}`],
    ['mensagens_ia', telefoneMensagensIa],
  ]) {
    const before = await sb(env, 'GET', table, `${q}&select=id&limit=1`)
    const del = await sb(env, 'DELETE', table, q)
    results.push({ table, deleteStatus: del.status, beforeRange: before.range, deleted: Array.isArray(del.data) ? del.data.length : del.status })
  }

  const memClear = await clearAgentConversationMemory(env, telefone)
  if (Number(idLead) > 0) {
    resetKommoInboundPollStateForLead(Number(idLead))
  }

  env.SUPABASE_DADOS_CLIENTE_TABLE = dadosTable
  const resetFields = {
    inscricao_form_status: null,
    inscricao_form_recebido_at: null,
    atendimento_ia: null,
    reativacao_ping_at: null,
    reativacao_moved_at: null,
  }
  const patch = await updateDadosCliente(env, { telefone, fields: resetFields })

  const memAfterCanonical = await sb(env, 'GET', memoryTable, `session_id=eq.${encodeURIComponent(sessionIdCanonical)}&select=id&limit=3`)
  const memAfterLegacy = await sb(env, 'GET', memoryTable, `session_id=eq.${encodeURIComponent(sessionIdLegacy)}&select=id&limit=3`)
  const msgAfter = await sb(env, 'GET', messagesTable, `${phoneOr}&select=id&limit=3`)

  console.log(
    JSON.stringify(
      {
        results,
        memoryClear: memClear,
        pollStateResetLeadId: Number(idLead) || null,
        patch,
        sessionIdCanonical,
        sessionIdLegacy,
        jid: telefoneToWhatsAppJid(telefone),
        verify: {
          memoryRemainingCanonical: memAfterCanonical.range || '0',
          memoryRemainingLegacy: memAfterLegacy.range || '0',
          messagesRemaining: msgAfter.range || '0',
        },
        hint:
          'Histórico Supabase + memória IA limpos (canonical 55... e legacy sem DDI). Reinicie agente_sumare no EasyPanel se o poll Kommo ainda usar cursor antigo em RAM. Chat no Kommo não é apagado. Hash do buffer no Redis tem TTL 1h (AGENT_FLUSH_HASH_TTL_SEC).',
      },
      null,
      2,
    ),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
