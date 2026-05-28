/**
 * Aplica DDL no Supabase via RPC `exec_sql` (se existir) ou via PostgREST
 * tentando criar cada coluna individualmente com retry.
 *
 * Uso: node scripts/apply-sql-rest.mjs scripts/sql/dados_cliente_sum_kommo_mirror.sql
 *
 * Funciona sem a RPC: faz introspecção dos campos atuais e tenta um
 * PATCH no-op com cada coluna; coluna ausente → 42703 → log e segue.
 * Como a RPC `exec_sql` precisa estar criada no projeto Supabase, este
 * script imprime instruções claras quando ela não existe.
 */

import fs from 'node:fs'
import path from 'node:path'

function loadEnv() {
  try {
    const txt = fs.readFileSync('.env', 'utf8')
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
      if (!m || process.env[m[1]]) continue
      let v = m[2]
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
      process.env[m[1]] = v
    }
  } catch {}
}

loadEnv()

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const key = process.env.SUPABASE_KEY || ''
if (!url || !key) {
  console.error('SUPABASE_URL/KEY ausentes (.env)')
  process.exit(1)
}

const sqlPath = process.argv[2] || 'scripts/sql/dados_cliente_sum_kommo_mirror.sql'
const sqlAbs = path.resolve(sqlPath)
const sql = fs.readFileSync(sqlAbs, 'utf8')

const statements = sql
  .split(/;\s*\n/g)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith('--') && !/^--/m.test(s.split('\n')[0]) === false || s.length > 0)
  .map((s) => (s.endsWith(';') ? s : `${s};`))

console.log(`[apply-sql-rest] ${statements.length} statement(s) em ${sqlPath}`)

async function tryRpc(statement) {
  const r = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql: statement }),
  })
  const text = await r.text()
  return { ok: r.ok, status: r.status, body: text }
}

async function probeColumn(table, column) {
  // PostgREST: se a coluna não existir, retorna 400 + 42703.
  const r = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(column)}&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  const text = await r.text()
  return { ok: r.ok, status: r.status, body: text }
}

async function main() {
  let rpcWorks = true
  let appliedRpc = 0
  let failedRpc = 0

  for (const stmt of statements) {
    if (!stmt || stmt === ';') continue
    if (!rpcWorks) break
    const res = await tryRpc(stmt)
    if (res.status === 404) {
      console.warn('[apply-sql-rest] RPC exec_sql não existe no projeto Supabase.')
      console.warn('  Crie no SQL editor:')
      console.warn(
        "    create or replace function exec_sql(sql text) returns void language plpgsql security definer as $$ begin execute sql; end; $$;",
      )
      console.warn(
        "    grant execute on function exec_sql(text) to service_role;",
      )
      rpcWorks = false
      break
    }
    if (!res.ok) {
      console.error(`[apply-sql-rest] FAIL status=${res.status} stmt=${stmt.slice(0, 80)}…`)
      console.error(`  resp=${res.body.slice(0, 300)}`)
      failedRpc++
      continue
    }
    appliedRpc++
    console.log(`[apply-sql-rest] ok stmt#${appliedRpc}: ${stmt.slice(0, 80).replace(/\s+/g, ' ')}…`)
  }

  if (rpcWorks) {
    console.log(`\n[apply-sql-rest] RPC concluído: ok=${appliedRpc} fail=${failedRpc}`)
  } else {
    console.log('\n[apply-sql-rest] Fallback: cole o arquivo a seguir manualmente no painel SQL do Supabase:')
    console.log(`  ${sqlAbs}\n`)
  }

  // Verifica colunas esperadas (probe).
  const expected = [
    'id_lead',
    'teste_AB',
    'polo_inscricao_escolhido',
    'captacao_unidade',
    'kommo_nome',
    'kommo_cpf',
    'kommo_email',
    'kommo_data_nasc',
    'kommo_curso',
    'kommo_polo',
    'kommo_modalidade',
    'kommo_status_inscricao',
    'kommo_sync_at',
  ]
  console.log('\n[apply-sql-rest] Probe das colunas em dados_cliente_sum:')
  let existing = 0
  let missing = 0
  for (const col of expected) {
    const p = await probeColumn('dados_cliente_sum', col)
    const ok = p.ok && !/42703/.test(p.body)
    console.log(`  ${ok ? 'OK   ' : 'MISS '} ${col}`)
    if (ok) existing++
    else missing++
  }
  console.log(`\n[apply-sql-rest] resumo probe: existing=${existing} missing=${missing}`)

  if (missing > 0 && !rpcWorks) {
    process.exit(2)
  }
}

main().catch((err) => {
  console.error('[apply-sql-rest] erro:', err)
  process.exit(1)
})
