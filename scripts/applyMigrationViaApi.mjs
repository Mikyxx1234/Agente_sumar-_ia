/**
 * Aplica migration via Supabase Management API.
 * Requer SUPABASE_ACCESS_TOKEN (Personal Access Token) no .env ou ambiente.
 * Gere em: https://supabase.com/dashboard/account/tokens
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sql = readFileSync(join(__dirname, 'sql', 'agent_training_feedback.sql'), 'utf8')
const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const ref = new URL(url).hostname.split('.')[0]
const token = process.env.SUPABASE_ACCESS_TOKEN || process.env.SB_ACCESS_TOKEN

if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN ausente. Gere em https://supabase.com/dashboard/account/tokens')
  process.exit(1)
}

const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql }),
})

const text = await r.text()
console.log('status', r.status)
console.log(text.slice(0, 500))
process.exit(r.ok ? 0 : 1)
