/**
 * Garante tabela feedback_job_runs no Supabase de feedback.
 * Uso: node --env-file=.env scripts/ensureFeedbackJobRunsTable.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(__dirname, 'sql', 'feedback_job_runs.sql')
const sql = readFileSync(sqlPath, 'utf8')

const url = (
  process.env.SUPABASE_URL_FEEDBACK ||
  process.env.VITE_SUPABASE_URL_FEEDBACK ||
  process.env.SUPABASE_URL ||
  ''
).replace(/\/$/, '')
const key =
  process.env.SUPABASE_KEY_FEEDBACK ||
  process.env.VITE_SUPABASE_KEY_FEEDBACK ||
  process.env.SUPABASE_KEY ||
  ''
const dbPassword = process.env.SUPABASE_DB_PASSWORD || process.env.DATABASE_PASSWORD || ''
const accessToken = process.env.SUPABASE_ACCESS_TOKEN || process.env.SB_ACCESS_TOKEN || ''

if (!url || !key) {
  console.error('SUPABASE_URL_FEEDBACK e SUPABASE_KEY_FEEDBACK (ou SUPABASE_*) são obrigatórios.')
  process.exit(1)
}

const ref = new URL(url).hostname.split('.')[0]

async function probeTable() {
  const r = await fetch(`${url}/rest/v1/feedback_job_runs?select=id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  return r.status
}

async function viaManagementApi() {
  if (!accessToken) return { ok: false, reason: 'no SUPABASE_ACCESS_TOKEN' }
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { ok: r.ok, status: r.status, data }
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
    return { ok: true, via: 'postgres' }
  } finally {
    await client.end()
  }
}

async function main() {
  const status = await probeTable()
  if (status === 200) {
    console.log('OK: feedback_job_runs já existe.')
    process.exit(0)
  }
  console.log(`Tabela ausente (HTTP ${status}). Aplicando migration…`)

  const mgmt = await viaManagementApi()
  if (mgmt.ok) {
    console.log('OK: feedback_job_runs criada via Management API.')
    process.exit(0)
  }
  if (mgmt.reason !== 'no SUPABASE_ACCESS_TOKEN') {
    console.warn('Management API:', mgmt.status, JSON.stringify(mgmt.data).slice(0, 400))
  }

  const pgRes = await viaPg()
  if (pgRes.ok) {
    console.log(`OK: feedback_job_runs criada via PostgreSQL (${pgRes.via}).`)
    process.exit(0)
  }

  console.error('Não foi possível criar feedback_job_runs automaticamente.')
  console.error(`Cole ${sqlPath} no SQL Editor do Supabase.`)
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
