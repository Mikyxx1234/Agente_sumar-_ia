/**
 * Reset de lead de teste no Supabase (histórico + estado do fluxo).
 * Uso: node scripts/reset-test-lead.mjs [telefone] [id_lead]
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { updateDadosCliente, telefoneToWhatsAppJid } from '../server/dadosClienteStore.js'

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

async function main() {
  const env = loadEnv()
  const telefone = normalizeTelefone(process.argv[2] || '5511944690752')
  const idLead = String(process.argv[3] || '23833445').trim()
  const sessionId = `${telefone}@s.whatsapp.net`
  const jid = `${telefone}@s.whatsapp.net`

  const memoryTable = env.N8N_MEMORY_TABLE || 'n8n_chat_histories'
  const messagesTable = env.SUPABASE_CHAT_MESSAGES_TABLE || 'chat_messages_sum'
  const chatsTable = env.SUPABASE_CHATS_TABLE || 'chats_sum'
  const dadosTable = env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum'
  const bufferTable = env.MESSAGE_BUFFER_TABLE || 'message_buffer'

  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    console.error('SUPABASE_URL e SUPABASE_KEY são obrigatórios (env ou .env).')
    process.exit(1)
  }

  console.log('Reset lead teste:', { telefone, idLead, sessionId, dadosTable, messagesTable, memoryTable })

  const results = []
  const phoneOr = `or=(phone.eq.${encodeURIComponent(telefone)},phone.eq.${encodeURIComponent(jid)})`

  // Histórico IA + buffer + telemetria
  for (const [table, q] of [
    [memoryTable, `session_id=eq.${encodeURIComponent(sessionId)}`],
    [messagesTable, phoneOr],
    [messagesTable, `id_lead=eq.${encodeURIComponent(idLead)}`],
    [chatsTable, `phone=eq.${telefone}`],
    [chatsTable, `phone=eq.${encodeURIComponent(jid)}`],
    [bufferTable, `session_id=eq.${encodeURIComponent(sessionId)}`],
    ['chat_messages_sum', phoneOr],
    ['chat_messages_sum', `id_lead=eq.${encodeURIComponent(idLead)}`],
    ['chats_sum', `phone=eq.${telefone}`],
    ['n8n_chat_histories', `session_id=eq.${encodeURIComponent(sessionId)}`],
    ['mensagens_ia', `usage->>lead_id=eq.${encodeURIComponent(idLead)}`],
    ['mensagens_ia', `usage->>telefone=eq.${encodeURIComponent(telefone)}`],
  ]) {
    const before = await sb(env, 'GET', table, `${q}&select=id&limit=1`)
    const del = await sb(env, 'DELETE', table, q)
    results.push({ table, deleteStatus: del.status, beforeRange: before.range, deleted: Array.isArray(del.data) ? del.data.length : del.status })
  }

  // Estado do fluxo
  // Marca "agora" em recebido_at para o scheduler ignorar notas antigas do Form no Kommo.
  env.SUPABASE_DADOS_CLIENTE_TABLE = dadosTable
  const resetFields = {
    inscricao_form_status: null,
    inscricao_form_recebido_at: new Date().toISOString(),
    atendimento_ia: null,
    reativacao_ping_at: null,
    reativacao_moved_at: null,
  }
  const patch = await updateDadosCliente(env, { telefone, fields: resetFields })

  // Confirma memória vazia
  const memAfter = await sb(env, 'GET', memoryTable, `session_id=eq.${encodeURIComponent(sessionId)}&select=id&limit=3`)
  const msgAfter = await sb(env, 'GET', messagesTable, `${phoneOr}&select=id&limit=3`)

  console.log(
    JSON.stringify(
      {
        results,
        patch,
        sessionId,
        jid: telefoneToWhatsAppJid(telefone),
        verify: {
          memoryRemaining: memAfter.range || '0',
          messagesRemaining: msgAfter.range || '0',
        },
        hint:
          'Histórico Supabase limpo. Reinicie o serviço no EasyPanel se o poll Kommo ainda puxar notas antigas (estado em memória). Chat no Kommo não é apagado.',
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
