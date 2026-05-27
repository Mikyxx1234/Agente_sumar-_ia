/**
 * Diagnóstico do lead CAIO SILVA (#23608285) — uso interno.
 * node --env-file=.env scripts/diag-caio.mjs
 */
const env = process.env
const url = env.SUPABASE_URL.replace(/\/+$/, '')
const key = env.SUPABASE_KEY
const headers = { apikey: key, Authorization: 'Bearer ' + key }

async function get(path) {
  const r = await fetch(url + '/rest/v1/' + path, { headers })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return t }
}

console.log('=== n8n_chat_histories (canonical 5511...) ===')
const a = await get('n8n_chat_histories?session_id=eq.5511970617878%40s.whatsapp.net&select=*&order=id.desc&limit=40')
console.log('total:', Array.isArray(a) ? a.length : 'err')
if (Array.isArray(a)) for (const m of a) {
  const t = m.message?.type || m.message?.data?.type
  const c = String(m.message?.data?.content ?? m.message?.content ?? '').replace(/\n/g, ' ').slice(0, 200)
  console.log(' ', m.id, t, '|', c)
}

console.log()
console.log('=== chat_messages_sum por phone ===')
const a2 = await get('chat_messages_sum?or=(phone.eq.11970617878,phone.eq.5511970617878)&select=*&order=created_at.desc&limit=30')
console.log('total:', Array.isArray(a2) ? a2.length : JSON.stringify(a2))
if (Array.isArray(a2)) for (const m of a2) {
  console.log(' ', m.created_at, 'lead=' + m.id_lead, 'phone=' + m.phone)
  console.log('   user:', String(m.user_message || '').slice(0, 110))
  console.log('   bot :', String(m.bot_message || '').slice(0, 110))
}

console.log()
console.log('=== dados_cliente_sum ===')
const a3 = await get('dados_cliente_sum?or=(telefone.eq.11970617878,telefone.eq.5511970617878,telefone.eq.11970617878%40s.whatsapp.net,telefone.eq.5511970617878%40s.whatsapp.net)&select=*')
console.log(JSON.stringify(a3, null, 2))

console.log()
console.log('=== mensagens_ia (últimas) ===')
const a4 = await get('mensagens_ia?or=(telefone.eq.11970617878,telefone.eq.5511970617878,telefone.ilike.*970617878*)&select=created_at,telefone,id_lead,direcao,texto,tipo&order=created_at.desc&limit=20')
console.log('total:', Array.isArray(a4) ? a4.length : JSON.stringify(a4))
if (Array.isArray(a4)) for (const m of a4) console.log(' ', m.created_at, m.direcao, m.tipo, '|', String(m.texto || '').slice(0, 110))
