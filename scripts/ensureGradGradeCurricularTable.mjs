/**
 * Garante tabela grad_grade_curricular + RPC match_grad_grade_curricular.
 * Uso: node --env-file=.env scripts/ensureGradGradeCurricularTable.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sql = readFileSync(join(__dirname, 'sql', 'grad_grade_curricular.sql'), 'utf8')

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const key = process.env.SUPABASE_KEY || ''
const dbPassword = process.env.SUPABASE_DB_PASSWORD || process.env.DATABASE_PASSWORD || ''
const accessToken = process.env.SUPABASE_ACCESS_TOKEN || process.env.SB_ACCESS_TOKEN || ''

if (!url || !key) {
  console.error('SUPABASE_URL e SUPABASE_KEY são obrigatórios.')
  process.exit(1)
}

const ref = new URL(url).hostname.split('.')[0]

async function probeTable() {
  const r = await fetch(`${url}/rest/v1/grad_grade_curricular?select=id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  return r.status
}

async function probeRpc() {
  const fake = Array.from({ length: 1536 }, () => 0)
  const r = await fetch(`${url}/rest/v1/rpc/match_grad_grade_curricular`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query_embedding: fake, match_count: 1, filter: {} }),
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
  return { ok: r.ok, status: r.status, data: text.slice(0, 500) }
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

const tableStatus = await probeTable()
const rpcStatus = await probeRpc()
console.log(`grad_grade_curricular table probe: ${tableStatus}`)
console.log(`match_grad_grade_curricular RPC probe: ${rpcStatus}`)

if (tableStatus === 200 && rpcStatus === 200) {
  console.log('Tabela e RPC já existem.')
  process.exit(0)
}

console.log('Criando tabela/RPC...')
let result = await viaPg()
if (!result.ok) result = await viaManagementApi()
if (!result.ok) {
  console.error('Falha ao aplicar SQL:', result)
  console.error('Execute manualmente scripts/sql/grad_grade_curricular.sql no SQL Editor do Supabase.')
  process.exit(1)
}

console.log('SQL aplicado:', result.via || result.status)
console.log('table probe:', await probeTable())
console.log('rpc probe:', await probeRpc())
