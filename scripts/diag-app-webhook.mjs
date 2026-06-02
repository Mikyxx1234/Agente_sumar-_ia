import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const APP_ID = process.argv[2]
const APP_SECRET = process.argv[3]
const V = 'v21.0'
if (!APP_ID || !APP_SECRET) { console.error('uso: node scripts/diag-app-webhook.mjs <app_id> <app_secret>'); process.exit(1) }
const appToken = `${APP_ID}|${APP_SECRET}`
console.log('app:', APP_ID, 'secret:', APP_SECRET.slice(0, 4) + '…(' + APP_SECRET.length + ' chars)')

const g = async (path) => {
  const sep = path.includes('?') ? '&' : '?'
  const r = await fetch(`https://graph.facebook.com/${V}/${path}${sep}access_token=${encodeURIComponent(appToken)}`)
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, j }
}

console.log('\n=== APP-LEVEL webhook subscriptions (callback default da Meta) ===')
const subs = await g(`${APP_ID}/subscriptions`)
console.log(subs.status, JSON.stringify(subs.j, null, 2))

// Pegar phone-number override usando o token de PRODUCAO (system user)
console.log('\n=== PHONE-NUMBER override (token de producao) ===')
const base = (env.EP_BASE_URL || 'http://168.231.99.126:3000').replace(/\/$/, '')
const lr = await fetch(`${base}/api/trpc/auth.login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: { email: env.EP_EMAIL, password: env.EP_PASSWORD } }) })
const tok = (await lr.json())?.result?.data?.json?.token
const inp = encodeURIComponent(JSON.stringify({ json: { projectName: 'banco', serviceName: 'agente_sumare' } }))
const ins = await fetch(`${base}/api/trpc/services.app.inspectService?input=${inp}`, { headers: { Authorization: `Bearer ${tok}` } })
const et = (await ins.json())?.result?.data?.json?.env || ''
const P = {}; for (const l of et.split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) P[l.slice(0, i).trim()] = l.slice(i + 1) }
const pid = P.WHATSAPP_PHONE_NUMBER_ID
const r2 = await fetch(`https://graph.facebook.com/${V}/${pid}?fields=webhook_configuration&access_token=${encodeURIComponent(P.WHATSAPP_ACCESS_TOKEN)}`)
console.log('phone', pid, r2.status, await r2.text())
