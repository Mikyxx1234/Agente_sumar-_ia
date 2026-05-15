/**
 * Reverte o webhook da instância Evolution para a URL antiga do n8n.
 * Útil pra rollback se algo der errado depois do deploy do backend.
 *
 *   node --env-file=.env scripts/restore_evolution_webhook_n8n.mjs
 */

const base = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '')
const key = process.env.EVOLUTION_API_KEY
const inst = process.env.EVOLUTION_INSTANCE

if (!base || !key || !inst) {
  console.error('Faltam EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE no .env')
  process.exit(1)
}

const N8N_URL = 'https://n8n-new-n8n.ca31ey.easypanel.host/webhook/ia_sum'
const instEnc = encodeURIComponent(inst)

const body = {
  webhook: {
    enabled: true,
    url: N8N_URL,
    webhookByEvents: false,
    webhookBase64: false,
    events: ['MESSAGES_UPSERT'],
  },
}

console.log(`Revertendo webhook de ${inst} para ${N8N_URL}\n`)
const r = await fetch(`${base}/webhook/set/${instEnc}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: key },
  body: JSON.stringify(body),
})
const t = await r.text()
console.log(`HTTP ${r.status}\n${t.slice(0, 500)}`)
