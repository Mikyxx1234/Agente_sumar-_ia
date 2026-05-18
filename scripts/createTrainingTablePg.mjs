import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sql = readFileSync(join(__dirname, 'sql', 'agent_training_feedback.sql'), 'utf8')

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const ref = new URL(url).hostname.split('.')[0]
const password = process.env.SUPABASE_DB_PASSWORD || process.env.DATABASE_PASSWORD

if (!password) {
  console.error('Defina SUPABASE_DB_PASSWORD no .env (Project Settings → Database → password)')
  process.exit(1)
}

const client = new pg.Client({
  host: `db.${ref}.supabase.co`,
  port: 5432,
  user: 'postgres',
  password,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

await client.connect()
await client.query(sql)
await client.end()
console.log('OK: agent_training_feedback criada em', ref)
