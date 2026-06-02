import fs from 'node:fs'
const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) { if (!line || line.startsWith('#') || !line.includes('=')) continue; const i = line.indexOf('='); const k = line.slice(0,i).trim(); if (!env[k]) env[k] = line.slice(i+1) }

const REAL_SECRET = process.argv[2] || ''
const base = (env.EP_BASE_URL || 'http://168.231.99.126:3000').replace(/\/$/, '')
const lr = await fetch(`${base}/api/trpc/auth.login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: { email: env.EP_EMAIL, password: env.EP_PASSWORD } }) })
const tok = (await lr.json())?.result?.data?.json?.token
const inp = encodeURIComponent(JSON.stringify({ json: { projectName: 'banco', serviceName: 'agente_sumare' } }))
const ins = await fetch(`${base}/api/trpc/services.app.inspectService?input=${inp}`, { headers: { Authorization: `Bearer ${tok}` } })
const data = (await ins.json())?.result?.data?.json || {}
const et = data.env || ''
const P = {}; for (const l of et.split(/\r?\n/)) { if (!l || l.startsWith('#') || !l.includes('=')) continue; const i = l.indexOf('='); P[l.slice(0, i).trim()] = l.slice(i + 1) }

const mask = (v) => v ? (v.length > 8 ? v.slice(0,4)+'…'+v.slice(-4)+` (${v.length})` : '***') : '(vazio)'
console.log('=== Prontidao do agente (producao) ===')
console.log('WHATSAPP_OUTBOUND_MODE       :', P.WHATSAPP_OUTBOUND_MODE)
console.log('WHATSAPP_WEBHOOK_VERIFY_TOKEN:', mask(P.WHATSAPP_WEBHOOK_VERIFY_TOKEN), '| valor:', P.WHATSAPP_WEBHOOK_VERIFY_TOKEN)
console.log('WHATSAPP_APP_SECRET          :', mask(P.WHATSAPP_APP_SECRET))
console.log('  -> bate com secret real?   :', REAL_SECRET ? (P.WHATSAPP_APP_SECRET === REAL_SECRET) : '(secret nao informado)')
console.log('WHATSAPP_PHONE_NUMBER_ID     :', P.WHATSAPP_PHONE_NUMBER_ID)
console.log('WHATSAPP_ACCESS_TOKEN        :', mask(P.WHATSAPP_ACCESS_TOKEN))
console.log('WHATSAPP_INGEST_PHONE_ALLOWLIST:', P.WHATSAPP_INGEST_PHONE_ALLOWLIST || '(vazio = atende todos)')
console.log('WHATSAPP_API_VERSION         :', P.WHATSAPP_API_VERSION)

// dominios do servico
const domains = data.domains || data?.proxy?.domains || []
console.log('\n=== Dominios do servico agente_sumare ===')
console.log(JSON.stringify(domains, null, 2))
console.log('\n(chaves disponiveis em inspectService:', Object.keys(data).join(', '), ')')
