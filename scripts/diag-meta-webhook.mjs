import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

// Puxa env de PRODUCAO (EasyPanel) p/ usar token real
const base = (env.EP_BASE_URL || 'http://168.231.99.126:3000').replace(/\/$/, '')
const lr = await fetch(`${base}/api/trpc/auth.login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ json: { email: env.EP_EMAIL, password: env.EP_PASSWORD } }),
})
const tok = (await lr.json())?.result?.data?.json?.token
const inp = encodeURIComponent(JSON.stringify({ json: { projectName: 'banco', serviceName: 'agente_sumare' } }))
const ins = await fetch(`${base}/api/trpc/services.app.inspectService?input=${inp}`, { headers: { Authorization: `Bearer ${tok}` } })
const et = (await ins.json())?.result?.data?.json?.env || ''
const P = {}
for (const l of et.split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) P[l.slice(0, i).trim()] = l.slice(i + 1) }

const TOKEN = P.WHATSAPP_ACCESS_TOKEN
const PID = P.WHATSAPP_PHONE_NUMBER_ID
const V = P.WHATSAPP_GRAPH_VERSION || 'v21.0'
const g = async (path) => {
  const r = await fetch(`https://graph.facebook.com/${V}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(TOKEN)}`)
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, j }
}

console.log('=== debug_token (app do token) ===')
const dt = await fetch(`https://graph.facebook.com/${V}/debug_token?input_token=${encodeURIComponent(TOKEN)}&access_token=${encodeURIComponent(TOKEN)}`)
const dtj = await dt.json()
const d = dtj?.data || {}
console.log(JSON.stringify({ app_id: d.app_id, application: d.application, type: d.type, scopes: d.scopes }, null, 0))

const wabaIds = new Set()
for (const gs of d.granular_scopes || []) {
  if (/whatsapp_business/.test(gs.scope)) for (const id of gs.target_ids || []) wabaIds.add(id)
}

console.log('\n=== /me + businesses + owned WABAs ===')
const me = await g('me?fields=id,name')
console.log('me:', JSON.stringify(me.j))
const bizs = await g('me/businesses?fields=id,name')
console.log('businesses:', JSON.stringify(bizs.j))
for (const b of bizs.j?.data || []) {
  const owned = await g(`${b.id}/owned_whatsapp_business_accounts?fields=id,name`)
  console.log(`  biz ${b.id} owned WABAs:`, JSON.stringify(owned.j))
  for (const w of owned.j?.data || []) wabaIds.add(w.id)
  const client = await g(`${b.id}/client_whatsapp_business_accounts?fields=id,name`)
  console.log(`  biz ${b.id} client WABAs:`, JSON.stringify(client.j))
  for (const w of client.j?.data || []) wabaIds.add(w.id)
}
console.log('\nWABAs encontradas:', [...wabaIds].join(', ') || '(nenhuma)')

console.log('\n=== webhook_configuration do phone number (override) ===')
const wc = await g(`${PID}?fields=webhook_configuration`)
console.log(wc.status, JSON.stringify(wc.j))

console.log('\n=== tentar campos extras do phone number ===')
const pn = await g(`${PID}?fields=id,display_phone_number,verified_name,status,name_status,messaging_limit_tier`)
console.log(pn.status, JSON.stringify(pn.j))

for (const wabaId of wabaIds) {
  console.log(`\n=== WABA ${wabaId} ===`)
  const info = await g(`${wabaId}?fields=name,id`)
  console.log('  info:', JSON.stringify(info.j))
  const phones = await g(`${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`)
  console.log('  phone_numbers:', JSON.stringify(phones.j))
  const sa = await g(`${wabaId}/subscribed_apps`)
  console.log('  subscribed_apps (recebem webhook):', sa.status, JSON.stringify(sa.j))
}
