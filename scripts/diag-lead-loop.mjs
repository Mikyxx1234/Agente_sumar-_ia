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
const intervalMs = Number(process.argv[3] || 12000)
const maxMin = Number(process.argv[4] || 10)

async function get(pathQ) {
  const r = await fetch(`${U}/rest/v1/${pathQ}`, { headers: H })
  const t = await r.text()
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

let lastSig = ''
const t0 = Date.now()

async function tick() {
  const dados = await get(
    `dados_cliente_sum?telefone=eq.${encodeURIComponent(sid)}&select=atendimento_ia,inscricao_form_status`,
  )
  const st = Array.isArray(dados) ? dados[0] || {} : {}
  const buf = await get(`message_buffer?session_id=eq.${encodeURIComponent(sid)}&select=content&order=id.asc`)
  const hist = await get(
    `n8n_chat_histories?session_id=eq.${encodeURIComponent(sid)}&select=id,message&order=id.desc&limit=4`,
  )
  const bufArr = Array.isArray(buf) ? buf.map((b) => b.content) : []
  const histArr = Array.isArray(hist)
    ? hist
        .slice()
        .reverse()
        .map((x) => {
          const m = x.message?.data || x.message || {}
          return `${m.type}:${String(m.content || '').slice(0, 70)}`
        })
    : []
  const sig = JSON.stringify({ st, bufArr, histArr })
  const ts = new Date().toLocaleTimeString('pt-BR')
  if (sig !== lastSig) {
    lastSig = sig
    console.log(`ACTIVITY ${ts} status=${st.inscricao_form_status} ia=${st.atendimento_ia}`)
    if (bufArr.length) console.log(`  buffer: ${JSON.stringify(bufArr)}`)
    for (const h of histArr) console.log(`  mem ${h}`)
  } else {
    console.log(`idle ${ts}`)
  }
}

await tick()
const timer = setInterval(async () => {
  if ((Date.now() - t0) / 60000 >= maxMin) {
    clearInterval(timer)
    console.log('WATCH_END')
    return
  }
  try {
    await tick()
  } catch (e) {
    console.log('err', e.message)
  }
}, intervalMs)
