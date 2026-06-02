#!/usr/bin/env node
/** Le o env do serviço agente_sumare no EasyPanel e mostra chaves criticas. */
import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const base = (env.EP_BASE_URL || 'http://168.231.99.126:3000').replace(/\/$/, '')
const email = env.EP_EMAIL
const password = env.EP_PASSWORD
if (!email || !password) {
  console.error('EP_EMAIL e EP_PASSWORD obrigatórios no .env')
  process.exit(1)
}

const loginRes = await fetch(`${base}/api/trpc/auth.login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ json: { email, password } }),
})
const login = await loginRes.json()
const token = login?.result?.data?.json?.token
if (!token) {
  console.error('login falhou', loginRes.status, JSON.stringify(login).slice(0, 300))
  process.exit(1)
}
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const input = encodeURIComponent(JSON.stringify({ json: { projectName: 'banco', serviceName: 'agente_sumare' } }))
const r = await fetch(`${base}/api/trpc/services.app.inspectService?input=${input}`, { headers })
const data = await r.json()
const svc = data?.result?.data?.json
const envText = svc?.env || svc?.service?.env || ''
console.log('inspect HTTP', r.status, 'envChars=', String(envText).length)

const KEYS = [
  'WHATSAPP_INGEST_PHONE_ALLOWLIST',
  'EVOLUTION_INGEST_PHONE_ALLOWLIST',
  'WHATSAPP_OUTBOUND_MODE',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'KOMMO_SCHEDULER_ENABLED',
  'KOMMO_INBOUND_POLL_ENABLED',
  'KOMMO_INBOUND_POLL_MODE',
  'KOMMO_AGENT_PIPELINE_ID',
  'KOMMO_AGENT_STATUS_ID',
  'KOMMO_AGENT_TEST_LEAD_IDS',
  'SUMARE_CAPTACAO_TEST_ALLOW',
  'SUMARE_CAPTACAO_ENABLED',
]
const map = new Map()
for (const line of String(envText).split(/\r?\n/)) {
  const i = line.indexOf('=')
  if (i < 0) continue
  map.set(line.slice(0, i).trim(), line.slice(i + 1))
}
console.log('\n=== chaves criticas em producao ===')
for (const k of KEYS) {
  console.log(`${k} = ${map.has(k) ? JSON.stringify(map.get(k)) : '(NAO DEFINIDA)'}`)
}
