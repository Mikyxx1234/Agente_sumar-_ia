import fs from 'fs'

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const U = env.SUPABASE_URL
const K = env.SUPABASE_KEY
const dadosTable = env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum'
const bufTable = env.MESSAGE_BUFFER_TABLE || 'message_buffer'
const histTable = 'n8n_chat_histories'

const phone = process.argv[2] || '5511944690752'
const sid = `${phone}@s.whatsapp.net`
const enc = encodeURIComponent(sid)
const H = {
  apikey: K,
  Authorization: 'Bearer ' + K,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
}

async function req(method, pathQ) {
  const r = await fetch(`${U}/rest/v1/${pathQ}`, { method, headers: H })
  const t = await r.text()
  let j
  try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, ok: r.ok, body: j }
}
const count = (b) => (Array.isArray(b) ? b.length : JSON.stringify(b))

console.log(`\n=== WIPE lead ${phone} (${sid}) ===`)

const before = await req('GET', `${dadosTable}?telefone=eq.${enc}&select=id_lead,atendimento_ia,inscricao_form_status,kommo_curso`)
console.log('ANTES dados_cliente:', JSON.stringify(before.body))

const delHist = await req('DELETE', `${histTable}?session_id=eq.${enc}`)
console.log(`DELETE memoria (${histTable}) status=${delHist.status}: removidas=${count(delHist.body)}`)

const delBuf = await req('DELETE', `${bufTable}?session_id=eq.${enc}`)
console.log(`DELETE buffer (${bufTable}) status=${delBuf.status}: removidas=${count(delBuf.body)}`)

const delDados = await req('DELETE', `${dadosTable}?telefone=eq.${enc}`)
console.log(`DELETE estado (${dadosTable}) status=${delDados.status}: removidas=${count(delDados.body)}`)

const after = await req('GET', `${dadosTable}?telefone=eq.${enc}&select=id_lead`)
console.log('DEPOIS dados_cliente:', JSON.stringify(after.body))
