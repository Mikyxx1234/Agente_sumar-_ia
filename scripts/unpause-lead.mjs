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

const phone = process.argv[2] || '5511944690752'
const sid = `${phone}@s.whatsapp.net`
const enc = encodeURIComponent(sid)
const H = {
  apikey: K,
  Authorization: 'Bearer ' + K,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
}

async function req(method, pathQ, body) {
  const r = await fetch(`${U}/rest/v1/${pathQ}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await r.text()
  let j
  try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, ok: r.ok, body: j }
}

console.log(`\n=== despausar + limpar buffer  lead ${phone} (${sid}) ===`)

// 1) Estado antes
const before = await req('GET', `${dadosTable}?telefone=eq.${enc}&select=id_lead,atendimento_ia,inscricao_form_status`)
console.log('ANTES:', JSON.stringify(before.body))

// 2) Despausar (atendimento_ia = null) — e opcionalmente resetar a inscrição
const reset = process.argv[3] === 'reset'
const patch = reset
  ? { atendimento_ia: null, inscricao_form_status: null, inscricao_form_recebido_at: null }
  : { atendimento_ia: null }
const unpause = await req('PATCH', `${dadosTable}?telefone=eq.${enc}`, patch)
console.log(`UNPAUSE${reset ? '+RESET' : ''} status=${unpause.status}:`, JSON.stringify(unpause.body))

// 3) Limpar buffer
const delBuf = await req('DELETE', `${bufTable}?session_id=eq.${enc}`)
console.log(`DELETE buffer status=${delBuf.status}:`, Array.isArray(delBuf.body) ? `removidas=${delBuf.body.length}` : JSON.stringify(delBuf.body))

// 4) Estado depois
const after = await req('GET', `${dadosTable}?telefone=eq.${enc}&select=id_lead,atendimento_ia,inscricao_form_status`)
console.log('DEPOIS:', JSON.stringify(after.body))
const bufAfter = await req('GET', `${bufTable}?session_id=eq.${enc}&select=content`)
console.log('BUFFER DEPOIS:', Array.isArray(bufAfter.body) ? `itens=${bufAfter.body.length}` : JSON.stringify(bufAfter.body))
