/**
 * Cria a tabela agent_training_feedback no Supabase (projeto principal).
 * Uso: node --env-file=.env scripts/ensureTrainingFeedbackTable.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(__dirname, 'sql', 'agent_training_feedback.sql')
const sql = readFileSync(sqlPath, 'utf8')

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const key = process.env.SUPABASE_KEY || ''
const dbPassword = process.env.SUPABASE_DB_PASSWORD || process.env.DATABASE_PASSWORD || ''
const accessToken = process.env.SUPABASE_ACCESS_TOKEN || process.env.SB_ACCESS_TOKEN || ''

if (!url || !key) {
  console.error('SUPABASE_URL e SUPABASE_KEY são obrigatórios no .env')
  process.exit(1)
}

const ref = new URL(url).hostname.split('.')[0]

async function probeTable() {
  const r = await fetch(`${url}/rest/v1/agent_training_feedback?select=execution_id&limit=1`, {
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
  try { data = JSON.parse(text) } catch { data = text }
  return { ok: r.ok, status: r.status, data }
}

async function viaPg() {
  if (!dbPassword) return { ok: false, reason: 'no SUPABASE_DB_PASSWORD' }
  let pg
  try {
    pg = await import('pg')
  } catch {
    return { ok: false, reason: 'pg module not installed — run: npm install pg' }
  }
  const host = `db.${ref}.supabase.co`
  const client = new pg.default.Client({
    host,
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
    console.log('OK: tabela agent_training_feedback já existe.')
    process.exit(0)
  }
  console.log(`Tabela ausente ou inacessível (HTTP ${status}). Criando…`)

  const mgmt = await viaManagementApi()
  if (mgmt.ok) {
    console.log('OK: tabela criada via Supabase Management API.')
    process.exit(0)
  }
  if (mgmt.reason !== 'no SUPABASE_ACCESS_TOKEN') {
    console.warn('Management API:', mgmt.status, JSON.stringify(mgmt.data).slice(0, 400))
  }

  const pg = await viaPg()
  if (pg.ok) {
    console.log(`OK: tabela criada via PostgreSQL (${pg.via}).`)
    process.exit(0)
  }
  console.error('Não foi possível criar a tabela automaticamente.')
  console.error('Opções:')
  console.error('  1) Cole scripts/sql/agent_training_feedback.sql no SQL Editor do Supabase')
  console.error('  2) Adicione SUPABASE_DB_PASSWORD no .env (senha do banco em Project Settings → Database)')
  console.error('  3) Adicione SUPABASE_ACCESS_TOKEN (Personal Access Token em supabase.com/dashboard/account/tokens)')
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
