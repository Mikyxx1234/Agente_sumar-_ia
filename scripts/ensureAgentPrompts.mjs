/**
 * Garante a tabela agent_prompts (+ agent_prompt_versions) no Supabase
 * principal e semeia os prompts base (APAGAR.txt já saneado → marca
 * Faculdade Sumaré). O seed é idempotente: só insere prompts ainda
 * inexistentes, nunca sobrescreve edições feitas pelo painel.
 *
 * Uso:
 *   node --env-file=.env scripts/ensureAgentPrompts.mjs
 *
 * Criação da tabela:
 *   - Tenta Management API (SUPABASE_ACCESS_TOKEN) e depois pg
 *     (SUPABASE_DB_PASSWORD). Se nenhum existir, imprime o SQL para
 *     colar no SQL Editor e segue tentando o seed (que falha limpo se a
 *     tabela ainda não existir).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadBasePrompts } from '../server/ai/promptsLoader.js'
import { countAgentPrompts, seedPrompts } from '../server/feedbackIA/promptsStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(__dirname, 'sql', 'agent_prompts.sql')
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

async function tableExists() {
  const r = await countAgentPrompts(env)
  if (r.ok) return true
  if (r.code === 'TABLE_MISSING') return false
  console.warn('Aviso ao checar tabela:', r.code, r.error || '')
  return false
}

async function viaManagementApi() {
  if (!accessToken) return { ok: false, reason: 'no SUPABASE_ACCESS_TOKEN' }
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  const text = await r.text()
  return { ok: r.ok, status: r.status, data: text.slice(0, 400) }
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

async function ensureTable() {
  if (await tableExists()) {
    console.log('OK: agent_prompts já existe.')
    return true
  }
  console.log('Tabela agent_prompts ausente. Tentando criar…')

  const mgmt = await viaManagementApi()
  if (mgmt.ok) {
    console.log('OK: agent_prompts criada via Management API.')
    return true
  }
  if (mgmt.reason !== 'no SUPABASE_ACCESS_TOKEN') {
    console.warn('Management API falhou:', mgmt.status, mgmt.data)
  }

  try {
    const pgRes = await viaPg()
    if (pgRes.ok) {
      console.log('OK: agent_prompts criada via PostgreSQL.')
      return true
    }
    if (pgRes.reason !== 'no SUPABASE_DB_PASSWORD') {
      console.warn('pg falhou:', pgRes.reason)
    }
  } catch (e) {
    console.warn('pg exceção:', e.message)
  }

  console.error('\nNão consegui criar a tabela automaticamente (faltam SUPABASE_ACCESS_TOKEN ou SUPABASE_DB_PASSWORD).')
  console.error('Cole o SQL abaixo no SQL Editor do Supabase e rode este script de novo:\n')
  console.error('----- BEGIN SQL -----')
  console.error(sql)
  console.error('-----  END SQL  -----\n')
  return false
}

async function main() {
  const ok = await ensureTable()
  if (!ok) process.exit(2)

  const base = await loadBasePrompts()
  if (!base.length) {
    console.error('Nenhum prompt base encontrado (APAGAR.txt). Abortando seed.')
    process.exit(3)
  }
  const rows = base.map((p) => ({
    prompt_id: p.id,
    node_name: p.name,
    node_type: p.type,
    body: p.body,
  }))
  const seed = await seedPrompts(env, rows)
  if (!seed.ok) {
    console.error('Seed falhou:', seed.code, seed.error || '')
    process.exit(4)
  }
  console.log(`Seed concluído: ${seed.inserted} inserido(s), ${seed.skipped} já existente(s). Total base: ${base.length}.`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
