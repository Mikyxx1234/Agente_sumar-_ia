#!/usr/bin/env node
/**
 * Seta uma ou mais chaves de env no serviço agente_sumare (EasyPanel),
 * preservando o restante. Depois redeploya e verifica.
 *
 * Uso:  node scripts/ep-set-env.mjs KEY=VALUE [KEY2=VALUE2 ...] [--dry] [--no-deploy]
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
const NO_DEPLOY = process.argv.includes('--no-deploy')
const pairs = process.argv.slice(2).filter((a) => !a.startsWith('--') && a.includes('='))
if (!pairs.length) { console.error('informe ao menos um KEY=VALUE'); process.exit(1) }
const updates = new Map()
for (const p of pairs) { const i = p.indexOf('='); updates.set(p.slice(0, i).trim(), p.slice(i + 1)) }

const base = (env.EP_BASE_URL || 'http://168.231.99.126:3000').replace(/\/$/, '')
const email = env.EP_EMAIL, password = env.EP_PASSWORD
if (!email || !password) { console.error('EP_EMAIL e EP_PASSWORD obrigatórios'); process.exit(1) }

const trpcGet = async (path, inputObj, token) => {
  const input = encodeURIComponent(JSON.stringify({ json: inputObj }))
  const r = await fetch(`${base}/api/trpc/${path}?input=${input}`, { headers: { Authorization: `Bearer ${token}` } })
  return { status: r.status, body: await r.json() }
}
const trpcPost = async (path, inputObj, token) => {
  const r = await fetch(`${base}/api/trpc/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ json: inputObj }) })
  return { status: r.status, body: await r.json() }
}

const loginRes = await fetch(`${base}/api/trpc/auth.login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: { email, password } }) })
const token = (await loginRes.json())?.result?.data?.json?.token
if (!token) { console.error('login falhou', loginRes.status); process.exit(1) }

const projectName = 'banco', serviceName = 'agente_sumare'
const insp = await trpcGet('services.app.inspectService', { projectName, serviceName }, token)
const envText = insp.body?.result?.data?.json?.env ?? ''
if (!envText) { console.error('não consegui ler env', insp.status); process.exit(1) }

const lines = String(envText).split(/\r?\n/)
const remaining = new Set(updates.keys())
const mask = (k, v) => /SECRET|TOKEN|PASSWORD|KEY/i.test(k) && v.length > 8 ? v.slice(0, 4) + '…' + v.slice(-4) : v
const newLines = lines.map((l) => {
  const i = l.indexOf('=')
  if (i < 0) return l
  const k = l.slice(0, i).trim()
  if (updates.has(k)) {
    remaining.delete(k)
    console.log(`ANTES : ${k}=${mask(k, l.slice(i + 1))}`)
    console.log(`DEPOIS: ${k}=${mask(k, updates.get(k))}`)
    return `${k}=${updates.get(k)}`
  }
  return l
})
for (const k of remaining) { console.log(`ADD   : ${k}=${mask(k, updates.get(k))}`); newLines.push(`${k}=${updates.get(k)}`) }
const newEnv = newLines.join('\n')

if (DRY) { console.log('\n[--dry] nada aplicado.'); process.exit(0) }

const upd = await trpcPost('services.app.updateEnv', { projectName, serviceName, env: newEnv }, token)
console.log('updateEnv HTTP', upd.status)
if (upd.status >= 400) { console.error('updateEnv falhou', JSON.stringify(upd.body).slice(0, 300)); process.exit(1) }

if (NO_DEPLOY) { console.log('--no-deploy: env atualizado sem redeploy.'); process.exit(0) }

const dep = await trpcPost('services.app.deployService', { projectName, serviceName }, token)
console.log('deploy HTTP', dep.status)
console.log('aguardando rebuild ~35s…')
await new Promise((r) => setTimeout(r, 35_000))
const verify = await trpcGet('services.app.inspectService', { projectName, serviceName }, token)
const vEnv = String(verify.body?.result?.data?.json?.env ?? '').split(/\r?\n/)
for (const k of updates.keys()) {
  const vLine = vEnv.find((l) => l.startsWith(`${k}=`))
  console.log('verif:', vLine ? `${k}=${mask(k, vLine.slice(k.length + 1))}` : `(${k} não encontrada)`)
}
try { const h = await fetch('https://banco-agente-sumare.6tqx2r.easypanel.host/api/health'); console.log('health:', (await h.text()).slice(0, 120)) } catch (e) { console.log('health falhou:', e.message) }
