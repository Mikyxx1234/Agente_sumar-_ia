#!/usr/bin/env node
/** Dispara deployService no EasyPanel (só rebuild, sem alterar env). */
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
  console.error('login falhou', loginRes.status, JSON.stringify(login).slice(0, 400))
  process.exit(1)
}

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

async function listServices() {
  const r = await fetch(`${base}/api/trpc/projects.listProjectsAndServices`, { headers })
  const data = await r.json()
  const services = data?.result?.data?.json?.services || []
  return services.find((s) => s.name === 'agente_sumare')
}

const before = await listServices()
console.log('commit antes:', before?.commit?.sha?.slice(0, 12) || 'n/a')

const deployRes = await fetch(`${base}/api/trpc/services.app.deployService`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ json: { projectName: 'banco', serviceName: 'agente_sumare' } }),
})
const deployText = await deployRes.text()
console.log('deploy HTTP', deployRes.status, deployText.slice(0, 500))
if (!deployRes.ok) process.exit(1)

console.log('aguardando rebuild…')
await new Promise((r) => setTimeout(r, 25_000))

const after = await listServices()
console.log('commit depois:', after?.commit?.sha?.slice(0, 12) || 'n/a')

const health = await fetch('https://banco-agente-sumare.6tqx2r.easypanel.host/api/health')
console.log('health:', await health.text())
