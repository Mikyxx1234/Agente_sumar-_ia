/**
 * Compara tempo RPC vs paginação legada (scope all).
 * Uso: node --env-file=.env scripts/probe-dashboard-rpc.mjs [startDate] [endDate]
 */
import { computeDashboardMetrics } from '../server/dashboardMetrics.js'

const startDate = process.argv[2] || '2026-06-15'
const endDate = process.argv[3] || '2026-06-17'
const env = { ...process.env }

async function run(label, rpc) {
  const e = { ...env, DASHBOARD_METRICS_RPC: rpc ? 'true' : 'false' }
  const t0 = Date.now()
  const out = await computeDashboardMetrics(e, { startDate, endDate, scopeMode: 'all' })
  const ms = Date.now() - t0
  console.log(`\n=== ${label} (${ms}ms) ===`)
  if (!out.ok) {
    console.log('ERRO:', out.error)
    return
  }
  console.log({
    source: out.meta?.source,
    messagesCount: out.messagesCount,
    whatsappSentExecutions: out.whatsappSentExecutions,
    tokens: out.tokens,
    cost: out.cost?.toFixed?.(2) ?? out.cost,
  })
}

console.log(`Período: ${startDate} → ${endDate}`)

if (String(env.DASHBOARD_METRICS_RPC || '').toLowerCase() !== 'true') {
  console.log('Dica: defina DASHBOARD_METRICS_RPC=true no .env para testar RPC.')
}

await run('RPC (se função existir + flag=true)', true)
await run('Legado paginado', false)
