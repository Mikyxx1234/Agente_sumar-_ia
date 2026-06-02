import fs from 'node:fs'
const env = { ...process.env }
const V = 'v21.0'
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) { if (!line || line.startsWith('#') || !line.includes('=')) continue; const i = line.indexOf('='); const k = line.slice(0,i).trim(); if (!env[k]) env[k] = line.slice(i+1) }

// credenciais de producao
const base = (env.EP_BASE_URL || 'http://168.231.99.126:3000').replace(/\/$/, '')
const lr = await fetch(`${base}/api/trpc/auth.login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: { email: env.EP_EMAIL, password: env.EP_PASSWORD } }) })
let tok = null
try { tok = (await lr.json())?.result?.data?.json?.token } catch {}
let P = env
if (tok) {
  const inp = encodeURIComponent(JSON.stringify({ json: { projectName: 'banco', serviceName: 'agente_sumare' } }))
  const ins = await fetch(`${base}/api/trpc/services.app.inspectService?input=${inp}`, { headers: { Authorization: `Bearer ${tok}` } })
  const et = (await ins.json())?.result?.data?.json?.env || ''
  P = {}; for (const l of et.split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) P[l.slice(0, i).trim()] = l.slice(i + 1) }
}

const AT = P.WHATSAPP_ACCESS_TOKEN
const PID = P.WHATSAPP_PHONE_NUMBER_ID
const WABA = P.WHATSAPP_WABA_ID || P.WHATSAPP_BUSINESS_ACCOUNT_ID || P.WABA_ID
console.log('phone_number_id:', PID, '| waba_id(env):', WABA)
console.log('env keys (whats/waba/business/account):', Object.keys(P).filter(k => /WABA|BUSINESS|ACCOUNT|WHATS|META/i.test(k)).join(', '))

const g = async (path, token) => {
  const sep = path.includes('?') ? '&' : '?'
  const r = await fetch(`https://graph.facebook.com/${V}/${path}${sep}access_token=${encodeURIComponent(token)}`)
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, j }
}

const APP_TOKEN = process.argv[2] || `${process.env.META_APP_ID || ''}|${process.env.META_APP_SECRET || ''}`
let waba = WABA
if (!waba) {
  console.log('\n-- descobrindo WABA via debug_token (app token) --')
  const dr = await fetch(`https://graph.facebook.com/${V}/debug_token?input_token=${encodeURIComponent(AT)}&access_token=${encodeURIComponent(APP_TOKEN)}`)
  const dj = await dr.json()
  console.log(dr.status, JSON.stringify(dj?.data?.granular_scopes || dj, null, 2))
  const gs = dj?.data?.granular_scopes || []
  for (const s of gs) { if (/whatsapp/i.test(s.scope) && s.target_ids?.length) { waba = waba || s.target_ids[0] } }
}
console.log('\nWABA usada:', waba)

if (waba) {
  console.log('\n=== subscribed_apps na WABA (quem recebe inbound) ===')
  const sa = await g(`${waba}/subscribed_apps`, AT)
  console.log(sa.status, JSON.stringify(sa.j, null, 2))
}
