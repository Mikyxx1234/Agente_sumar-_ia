/**
 * Smoke test pós-deploy em produção (ou staging).
 * Uso: node scripts/smoke-prod-deploy.mjs https://seu-host.tld
 */
const BASE = (process.argv[2] || process.env.PROD_BASE_URL || '').replace(/\/$/, '')
if (!BASE) {
  console.error('Informe a URL: node scripts/smoke-prod-deploy.mjs https://host')
  process.exit(1)
}

const j = async (path, opts = {}) => {
  const r = await fetch(`${BASE}${path}`, opts)
  const t = await r.text()
  try { return { status: r.status, data: JSON.parse(t) } } catch { return { status: r.status, raw: t.slice(0, 200) } }
}

console.log(`\n=== Smoke deploy: ${BASE} ===\n`)

const prompts = await j('/api/feedback-ia/prompts')
if (prompts.status !== 200 || !prompts.data?.ok) {
  console.log('❌ GET /api/feedback-ia/prompts falhou', prompts.status, prompts.data || prompts.raw)
  process.exit(1)
}
const d = prompts.data
console.log(`✅ Prompts API: flag=${d.flagEnabled} overrides=${d.overridesAvailable} count=${d.data?.length}`)
if (!d.flagEnabled) console.log('⚠️  AGENT_DB_OVERRIDES_ENABLED não está true em produção')
const orq = d.data?.find((p) => p.name === 'orquestrador')
if (orq) {
  console.log(`   orquestrador v${orq.version} len=${orq.body.length} guard=${orq.body.includes('CURSO FORA DO CATÁLOGO')} transfer=${orq.body.includes('registrar_transferencia')}`)
}

const agent = await j('/api/agent/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ telefone: '5511990000999', pushName: 'Smoke', userMessage: 'vocês têm o curso de Medicina?' }),
})
if (agent.status === 200 && agent.data?.reply) {
  const ok = /não (faz parte|consta|temos|oferece)|cat[aá]logo/i.test(agent.data.reply)
  console.log(`${ok ? '✅' : '❌'} Agent Medicina: ${agent.data.reply.replace(/\s+/g, ' ').slice(0, 100)}`)
} else {
  console.log('❌ POST /api/agent/run falhou', agent.status, agent.data?.error || agent.raw)
}

console.log('\n=== Fim smoke ===\n')
