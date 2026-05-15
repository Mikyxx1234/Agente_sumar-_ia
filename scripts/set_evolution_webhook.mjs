/**
 * Aponta o webhook da instância Evolution para a URL pública do nosso backend.
 *
 *   node --env-file=.env scripts/set_evolution_webhook.mjs
 *
 * Lê PUBLIC_WEBHOOK_BASE_URL do .env e seta:
 *   https://<base>/api/evolution/webhook
 *
 * Eventos: MESSAGES_UPSERT, CONTACTS_UPSERT, CONTACTS_UPDATE
 * (CONTACTS_* são necessários quando a Evolution está em modo Cloud API
 *  porque o messages.upsert vem com o JID do negócio, e o telefone real
 *  do cliente chega via contacts.*; o handler espera ambos).
 *
 * Antes de rodar valida que a URL responde 200 em /api/evolution/health
 * — assim você não troca o webhook e perde mensagens pra um 502.
 */

const base = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '')
const key = process.env.EVOLUTION_API_KEY
const inst = process.env.EVOLUTION_INSTANCE
const publicBase = (process.env.PUBLIC_WEBHOOK_BASE_URL || '').replace(/\/$/, '')

if (!base || !key || !inst) {
  console.error('Faltam EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE no .env')
  process.exit(1)
}
if (!publicBase) {
  console.error('Faltam PUBLIC_WEBHOOK_BASE_URL no .env')
  process.exit(1)
}

const webhookUrl = `${publicBase}/api/evolution/webhook`
const healthUrl = `${publicBase}/api/evolution/health`

console.log(`Evolution base:   ${base}`)
console.log(`Instance:         ${inst}`)
console.log(`Webhook alvo:     ${webhookUrl}`)
console.log()

console.log(`1) Pré-flight: GET ${healthUrl}`)
try {
  const r = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) })
  if (!r.ok) {
    console.error(`   ❌ HTTP ${r.status} — backend público não está respondendo. Aborta.`)
    console.error('   Deploy o EasyPanel primeiro e tente de novo.')
    process.exit(2)
  }
  console.log(`   ✅ HTTP ${r.status}`)
} catch (e) {
  console.error(`   ❌ Erro de conexão: ${e.message}`)
  console.error('   Deploy o EasyPanel primeiro e tente de novo.')
  process.exit(2)
}

const instEnc = encodeURIComponent(inst)
const body = {
  webhook: {
    enabled: true,
    url: webhookUrl,
    webhookByEvents: false,
    webhookBase64: false,
    events: ['MESSAGES_UPSERT', 'CONTACTS_UPSERT', 'CONTACTS_UPDATE'],
  },
}

console.log(`\n2) POST ${base}/webhook/set/${instEnc}`)
const r = await fetch(`${base}/webhook/set/${instEnc}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: key },
  body: JSON.stringify(body),
})
const text = await r.text()
console.log(`   HTTP ${r.status}`)
console.log(`   ${text.slice(0, 600)}`)

if (!r.ok) process.exit(3)

console.log(`\n3) Confirmação: GET ${base}/webhook/find/${instEnc}`)
const r2 = await fetch(`${base}/webhook/find/${instEnc}`, { headers: { apikey: key } })
const t2 = await r2.text()
console.log(`   HTTP ${r2.status}`)
try { console.log('   ' + JSON.stringify(JSON.parse(t2), null, 2).split('\n').join('\n   ')) }
catch { console.log('   ' + t2.slice(0, 400)) }

console.log('\n✅ Webhook configurado. A próxima mensagem do WhatsApp deve cair em /api/evolution/webhook do backend.')
