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
  const envPath = path.join(root, '.env')
  const env = {}
  if (!fs.existsSync(envPath)) return env
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    env[line.slice(0, i)] = line.slice(i + 1)
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
  const telefone = normalizeTelefone(process.argv[2] || '5511998209798')
  const idLead = process.argv[3] || '23758445'
  const sessionId = `${telefone}@s.whatsapp.net`

  const memoryTable = env.N8N_MEMORY_TABLE || 'n8n_chat_histories'
  const messagesTable = env.SUPABASE_CHAT_MESSAGES_TABLE || 'chat_messages'
  const chatsTable = env.SUPABASE_CHATS_TABLE || 'chats'
  const dadosTable = env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum'
  const bufferTable = env.MESSAGE_BUFFER_TABLE || 'message_buffer'

  console.log('Reset lead teste:', { telefone, idLead, sessionId, dadosTable, messagesTable, memoryTable })

  const results = []

  // Histórico IA
  for (const [table, q] of [
    [memoryTable, `session_id=eq.${encodeURIComponent(sessionId)}`],
    [messagesTable, `phone=eq.${telefone}`],
    [chatsTable, `phone=eq.${telefone}`],
    [bufferTable, `session_id=eq.${encodeURIComponent(sessionId)}`],
    ['chat_messages_sum', `phone=eq.${telefone}`],
    ['chats_sum', `phone=eq.${telefone}`],
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

  console.log(
    JSON.stringify(
      {
        results,
        patch,
        sessionId,
        jid: telefoneToWhatsAppJid(telefone),
        hint: 'Faça deploy do código com filtro de notas Kommo antes de testar do zero em produção.',
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
