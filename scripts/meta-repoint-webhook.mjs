#!/usr/bin/env node
/**
 * Repointa o override de webhook do NÚMERO (phone-number-level) na Meta.
 * O override do número tem prioridade sobre WABA e sobre o callback do app.
 *
 *   POST /{phone-number-id}
 *     { webhook_configuration: { override_callback_uri, verify_token } }
 *
 * Uso:
 *   node scripts/meta-repoint-webhook.mjs agent     # aponta pro nosso agente
 *   node scripts/meta-repoint-webhook.mjs n8n       # ROLLBACK: volta pro n8n
 *   node scripts/meta-repoint-webhook.mjs status    # só mostra a config atual
 */
import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('='); const k = line.slice(0, i).trim(); if (!env[k]) env[k] = line.slice(i + 1)
}

const TARGETS = {
  agent: 'https://banco-agente-sumare.6tqx2r.easypanel.host/api/whatsapp/webhook',
  n8n: 'https://n8n-new-n8n.ca31ey.easypanel.host/webhook/ab67a51f-aa13-4f35-9277-ceac2d47ceab/webhook',
}
const arg = (process.argv[2] || 'status').toLowerCase()
const V = 'v21.0'

// credenciais de producao
const base = (env.EP_BASE_URL || 'http://168.231.99.126:3000').replace(/\/$/, '')
const lr = await fetch(`${base}/api/trpc/auth.login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: { email: env.EP_EMAIL, password: env.EP_PASSWORD } }) })
const tok = (await lr.json())?.result?.data?.json?.token
const inp = encodeURIComponent(JSON.stringify({ json: { projectName: 'banco', serviceName: 'agente_sumare' } }))
const ins = await fetch(`${base}/api/trpc/services.app.inspectService?input=${inp}`, { headers: { Authorization: `Bearer ${tok}` } })
const et = (await ins.json())?.result?.data?.json?.env || ''
const P = {}; for (const l of et.split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) P[l.slice(0, i).trim()] = l.slice(i + 1) }
const PID = P.WHATSAPP_PHONE_NUMBER_ID
const AT = P.WHATSAPP_ACCESS_TOKEN
const VERIFY = P.WHATSAPP_WEBHOOK_VERIFY_TOKEN
if (!PID || !AT || !VERIFY) { console.error('faltam WHATSAPP_PHONE_NUMBER_ID/ACCESS_TOKEN/WEBHOOK_VERIFY_TOKEN em prod'); process.exit(1) }

const readConfig = async () => {
  const r = await fetch(`https://graph.facebook.com/${V}/${PID}?fields=webhook_configuration&access_token=${encodeURIComponent(AT)}`)
  return { status: r.status, body: await r.text() }
}

console.log('phone_number_id:', PID)
const before = await readConfig()
console.log('ANTES:', before.status, before.body)

if (arg === 'status') process.exit(0)
if (!TARGETS[arg]) { console.error('alvo inválido. use: agent | n8n | status'); process.exit(1) }

const url = TARGETS[arg]
console.log(`\n→ setando override do número para [${arg}]: ${url}`)
const post = await fetch(`https://graph.facebook.com/${V}/${PID}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AT}` },
  body: JSON.stringify({ webhook_configuration: { override_callback_uri: url, verify_token: VERIFY } }),
})
console.log('POST resultado:', post.status, await post.text())

await new Promise((r) => setTimeout(r, 1500))
const after = await readConfig()
console.log('\nDEPOIS:', after.status, after.body)
