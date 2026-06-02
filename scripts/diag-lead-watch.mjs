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
const phone = process.argv[2] || '5511944690752'
const sid = `${phone}@s.whatsapp.net`
const H = { apikey: K, Authorization: 'Bearer ' + K }

async function get(pathQ) {
  const r = await fetch(`${U}/rest/v1/${pathQ}`, { headers: H })
  const t = await r.text()
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

console.log(`\n=== ${new Date().toLocaleTimeString('pt-BR')}  lead ${phone} ===`)

const dados = await get(
  `dados_cliente_sum?telefone=eq.${encodeURIComponent(sid)}&select=id_lead,atendimento_ia,inscricao_form_status,inscricao_form_recebido_at,kommo_curso`,
)
console.log('estado:', JSON.stringify(Array.isArray(dados) ? dados[0] : dados))

const buf = await get(
  `message_buffer?session_id=eq.${encodeURIComponent(sid)}&select=content,created_at&order=id.asc`,
)
console.log('buffer:', Array.isArray(buf) ? buf.map((b) => b.content) : buf)

const hist = await get(
  `n8n_chat_histories?session_id=eq.${encodeURIComponent(sid)}&select=id,message&order=id.desc&limit=6`,
)
if (Array.isArray(hist)) {
  console.log('memoria (mais recente embaixo):')
  hist.reverse().forEach((x) => {
    const m = x.message?.data || x.message || {}
    console.log(`  [${x.id}] ${String(m.type || '').padEnd(5)} ${String(m.content || '').slice(0, 90)}`)
  })
} else {
  console.log('memoria:', hist)
}
