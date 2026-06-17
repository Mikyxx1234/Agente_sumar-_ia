/**
 * Cria função RPC dashboard_metrics + backfill usage.whatsapp_sent.
 *
 * Uso:
 *   node --env-file=.env scripts/ensureDashboardMetricsRpc.mjs
 *
 * Depois, no .env local:
 *   DASHBOARD_METRICS_RPC=true
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(__dirname, 'sql', 'dashboard_metrics_rpc.sql')
const sql = readFileSync(sqlPath, 'utf8')

const env = process.env
const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
const dbPassword = env.SUPABASE_DB_PASSWORD || env.DATABASE_PASSWORD || ''
const accessToken = env.SUPABASE_ACCESS_TOKEN || env.SB_ACCESS_TOKEN || ''

if (!url || !key) {
  console.error('SUPABASE_URL e SUPABASE_KEY são obrigatórios no .env.')
  process.exit(1)
}

const ref = new URL(url).hostname.split('.')[0]

async function viaManagementApi() {
  if (!accessToken) return { ok: false, reason: 'no SUPABASE_ACCESS_TOKEN' }
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  const text = await r.text()
  return { ok: r.ok, status: r.status, data: text.slice(0, 600) }
}

async function viaPg() {
  if (!dbPassword) return { ok: false, reason: 'no SUPABASE_DB_PASSWORD' }
  const pg = await import('pg')
  const client = new pg.default.Client({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: dbPassword,
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  try {
    await client.query(sql)
    return { ok: true }
  } finally {
    await client.end()
  }
}

async function probeRpc() {
  const start = '2026-06-17T03:00:00.000Z'
  const end = '2026-06-18T02:59:59.999Z'
  const t0 = Date.now()
  const r = await fetch(`${url}/rest/v1/rpc/dashboard_metrics`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ p_start: start, p_end: end }),
  })
  const ms = Date.now() - t0
  const text = await r.text()
  if (!r.ok) {
    console.error('Probe RPC falhou:', r.status, text.slice(0, 400))
    return false
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    console.error('RPC retornou não-JSON:', text.slice(0, 200))
    return false
  }
  console.log(`Probe RPC OK em ${ms}ms:`, JSON.stringify(data, null, 2).slice(0, 800))
  return true
}

console.log('Aplicando dashboard_metrics_rpc.sql …')

let applied = false
for (const fn of [viaManagementApi, viaPg]) {
  const out = await fn()
  if (out.ok) {
    applied = true
    console.log('SQL aplicado via', fn.name)
    break
  }
  console.log(fn.name, '→', out.reason || out.data || out.status)
}

if (!applied) {
  console.error('\nNão foi possível aplicar automaticamente.')
  console.error('Cole scripts/sql/dashboard_metrics_rpc.sql no SQL Editor do Supabase.')
  process.exit(1)
}

console.log('\nTestando RPC …')
const ok = await probeRpc()
if (!ok) process.exit(1)

console.log('\nPróximo passo: adicione DASHBOARD_METRICS_RPC=true no .env e reinicie npm run start:local')
