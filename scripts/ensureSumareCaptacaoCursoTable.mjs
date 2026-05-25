/**
 * Cria a tabela sumare_captacao_curso no Supabase.
 * Uso: node --env-file=.env scripts/ensureSumareCaptacaoCursoTable.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(__dirname, 'sql', 'sumare_captacao_curso.sql')
const sql = readFileSync(sqlPath, 'utf8')
const table = process.env.SUMARE_CAPTACAO_CURSO_TABLE || 'sumare_captacao_curso'

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
  const r = await fetch(
    `${url}/rest/v1/${encodeURIComponent(table)}?select=codigo_original&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  )
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
  let pg
  try {
    pg = await import('pg')
  } catch {
    return { ok: false, reason: 'pg module not installed' }
  }
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
    console.log(`Tabela ${table} já existe e está acessível (GET 200).`)
    return
  }
  console.log(`Tabela ${table} probe HTTP ${status} — aplicando migration...`)

  const mgmt = await viaManagementApi()
  if (mgmt.ok) {
    console.log('Migration OK via Supabase Management API')
    return
  }
  console.warn('Management API:', mgmt.reason || mgmt.status, mgmt.data)

  const pg = await viaPg()
  if (pg.ok) {
    console.log(`Migration OK via Postgres (${pg.via})`)
    return
  }
  console.error('Falha na migration:', pg.reason || 'unknown')
  console.error(`Rode manualmente no SQL Editor:\n${sqlPath}`)
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
