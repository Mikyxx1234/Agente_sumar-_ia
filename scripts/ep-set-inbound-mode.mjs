#!/usr/bin/env node
/**
 * Troca KOMMO_INBOUND_POLL_MODE no serviço agente_sumare (EasyPanel).
 * Altera SOMENTE essa linha; preserva o restante do env. Depois redeploya.
 *
 * Uso:  node scripts/ep-set-inbound-mode.mjs dispatcher
 *       node scripts/ep-set-inbound-mode.mjs dispatcher --dry
 */
import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const DRY = process.argv.includes('--dry')
const VALUE = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'dispatcher'
const base = (env.EP_BASE_URL || 'http://168.231.99.126:3000').replace(/\/$/, '')
const email = env.EP_EMAIL
const password = env.EP_PASSWORD
if (!email || !password) {
  console.error('EP_EMAIL e EP_PASSWORD obrigatórios no .env')
  process.exit(1)
}

async function trpcGet(path, inputObj, token) {
  const input = encodeURIComponent(JSON.stringify({ json: inputObj }))
  const r = await fetch(`${base}/api/trpc/${path}?input=${input}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  return { status: r.status, body: await r.json() }
}
async function trpcPost(path, inputObj, token) {
  const r = await fetch(`${base}/api/trpc/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: inputObj }),
  })
  return { status: r.status, body: await r.json() }
}

const loginRes = await fetch(`${base}/api/trpc/auth.login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ json: { email, password } }),
})
const token = (await loginRes.json())?.result?.data?.json?.token
if (!token) {
  console.error('login falhou', loginRes.status)
  process.exit(1)
}

const projectName = 'banco'
const serviceName = 'agente_sumare'

const insp = await trpcGet('services.app.inspectService', { projectName, serviceName }, token)
const svc = insp.body?.result?.data?.json
const envText = svc?.env ?? svc?.service?.env ?? ''
if (!envText) {
  console.error('não consegui ler env do serviço', insp.status, JSON.stringify(insp.body).slice(0, 300))
  process.exit(1)
}

const KEY = 'KOMMO_INBOUND_POLL_MODE'
const lines = String(envText).split(/\r?\n/)
let found = false
const newLines = lines.map((l) => {
  const i = l.indexOf('=')
  if (i < 0) return l
  if (l.slice(0, i).trim() === KEY) {
    found = true
    console.log(`ANTES: ${l}`)
    console.log(`DEPOIS: ${KEY}=${VALUE}`)
    return `${KEY}=${VALUE}`
  }
  return l
})
if (!found) {
  console.log(`Chave ${KEY} não existia — adicionando ${KEY}=${VALUE}`)
  newLines.push(`${KEY}=${VALUE}`)
}
const newEnv = newLines.join('\n')

if (DRY) {
  console.log('\n[--dry] nada aplicado.')
  process.exit(0)
}

let upd = await trpcPost('services.app.updateEnv', { projectName, serviceName, env: newEnv }, token)
console.log('updateEnv HTTP', upd.status, JSON.stringify(upd.body).slice(0, 200))
if (upd.status >= 400) {
  console.error('updateEnv falhou — verifique o nome da mutation no EasyPanel.')
  process.exit(1)
}

const dep = await trpcPost('services.app.deployService', { projectName, serviceName }, token)
console.log('deploy HTTP', dep.status, JSON.stringify(dep.body).slice(0, 150))

console.log('aguardando rebuild…')
await new Promise((r) => setTimeout(r, 30_000))
const verify = await trpcGet('services.app.inspectService', { projectName, serviceName }, token)
const vEnv = verify.body?.result?.data?.json?.env ?? ''
const vLine = String(vEnv).split(/\r?\n/).find((l) => l.startsWith(`${KEY}=`))
console.log('verificação pós-deploy:', vLine ?? '(linha não encontrada)')
try {
  const health = await fetch('https://banco-agente-sumare.6tqx2r.easypanel.host/api/health')
  console.log('health:', await health.text())
} catch (e) {
  console.log('health check falhou:', e.message)
}
