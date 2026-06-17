/**
 * Atualiza env em produção (EasyPanel) e dispara redeploy do serviço agente_sumare.
 *
 *   node --env-file=.env scripts/deploy-prod-dedupe-fix.mjs
 *   node --env-file=.env scripts/deploy-prod-dedupe-fix.mjs --dry-run
 */
import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const dryRun = process.argv.includes('--dry-run')
const base = (env.EP_BASE_URL || 'http://168.231.99.126:3000').replace(/\/$/, '')
const projectName = env.EP_PROJECT || 'banco'
const serviceName = env.EP_SERVICE || 'agente_sumare'

async function epCall(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(globalThis.__epToken ? { Authorization: `Bearer ${globalThis.__epToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: r.ok, status: r.status, data }
}

const login = await epCall('/api/trpc/auth.login', {
  method: 'POST',
  body: { json: { email: env.EP_EMAIL, password: env.EP_PASSWORD } },
})
globalThis.__epToken = login.data?.result?.data?.json?.token
if (!globalThis.__epToken) {
  console.error('EasyPanel login falhou', login.status, JSON.stringify(login.data).slice(0, 300))
  process.exit(1)
}
console.log('EasyPanel login OK')

const input = encodeURIComponent(JSON.stringify({ json: { projectName, serviceName } }))
const inspect = await epCall(`/api/trpc/services.app.inspectService?input=${input}`)
const svc = inspect.data?.result?.data?.json
if (!svc) {
  console.error('inspectService falhou', inspect.status, JSON.stringify(inspect.data).slice(0, 400))
  process.exit(1)
}

let envText = String(svc.env || '')
const required = {
  SUPABASE_CHATS_TABLE: 'chats_sum',
  SUPABASE_CHAT_MESSAGES_TABLE: 'chat_messages_sum',
}

let changed = false
for (const [key, val] of Object.entries(required)) {
  const re = new RegExp(`^${key}=.*$`, 'm')
  if (re.test(envText)) {
    const cur = envText.match(re)?.[0]?.slice(key.length + 1)
    if (cur === val) {
      console.log(`${key} já OK (${val})`)
    } else {
      console.log(`${key}: ${cur || '(vazio)'} → ${val}`)
      envText = envText.replace(re, `${key}=${val}`)
      changed = true
    }
  } else {
    console.log(`${key}: (ausente) → ${val}`)
    envText = `${envText.trim()}\n${key}=${val}\n`
    changed = true
  }
}

if (dryRun) {
  console.log('\n[dry-run] env changed=', changed)
  process.exit(0)
}

if (changed) {
  const updatePaths = [
    '/api/trpc/services.app.updateService',
    '/api/trpc/services.app.saveService',
  ]
  let updated = false
  for (const path of updatePaths) {
    const r = await epCall(path, {
      method: 'POST',
      body: {
        json: {
          projectName,
          serviceName,
          env: envText,
        },
      },
    })
    if (r.ok && !r.data?.error) {
      console.log(`env atualizado via ${path}`)
      updated = true
      break
    }
    console.warn(`${path} falhou (${r.status})`, JSON.stringify(r.data).slice(0, 200))
  }
  if (!updated) {
    console.warn('Não foi possível atualizar env via API — defaults no código já cobrem chats_sum')
  }
} else {
  console.log('env produção já contém tabelas corretas (ou defaults no código bastam)')
}

const redeployPaths = [
  '/api/trpc/services.app.redeployService',
  '/api/trpc/services.app.deployService',
  '/api/trpc/services.app.restartService',
]
let redeployed = false
for (const path of redeployPaths) {
  const r = await epCall(path, {
    method: 'POST',
    body: { json: { projectName, serviceName } },
  })
  if (r.ok) {
    console.log(`redeploy solicitado via ${path}`)
    redeployed = true
    break
  }
  console.warn(`${path} → ${r.status}`)
}

if (!redeployed) {
  console.log('Redeploy manual: push git → EasyPanel rebuild automático')
}

const prodUrl = (env.PROD_URL || 'https://banco-agente-sumare.6tqx2r.easypanel.host').replace(/\/$/, '')
console.log(`\nAguardando health ${prodUrl}/api/health …`)
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  try {
    const h = await fetch(`${prodUrl}/api/health`, { signal: AbortSignal.timeout(8000) })
    if (h.ok) {
      const j = await h.json().catch(() => ({}))
      console.log(`health OK (${i + 1}):`, JSON.stringify(j).slice(0, 200))
      process.exit(0)
    }
    console.log(`health ${h.status} tentativa ${i + 1}/24`)
  } catch (e) {
    console.log(`health aguardando… ${i + 1}/24 (${e.message})`)
  }
}
console.warn('Health não respondeu a tempo — verifique painel EasyPanel')
process.exit(1)
