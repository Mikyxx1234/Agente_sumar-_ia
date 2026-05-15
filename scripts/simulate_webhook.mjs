// Simula um webhook Evolution messages.upsert no backend local.
// Roda: node --env-file=.env scripts/simulate_webhook.mjs

const TARGET = 'http://localhost:8000/api/evolution/webhook'
const phoneDigits = '5511945010493'
const sessionId = `${phoneDigits}@s.whatsapp.net`
const text = process.argv.slice(2).join(' ') || 'Oi, queria saber valores do curso de Administração'

// Importante: NÃO setar `sender` igual ao `key.remoteJid`, senão o backend
// trata como "JID do negócio" (modo Cloud via Evolution) e fica esperando
// o evento contacts.* pra cruzar. Aqui simulamos um payload Baileys puro.
const payload = {
  event: 'messages.upsert',
  instance: process.env.EVOLUTION_INSTANCE || 'comercial_cruzeiro',
  data: {
    key: {
      remoteJid: sessionId,
      fromMe: false,
      id: 'TESTE-' + Date.now(),
    },
    pushName: 'Caio Teste',
    message: { conversation: text },
    messageType: 'conversation',
    messageTimestamp: Math.floor(Date.now() / 1000),
  },
  date_time: new Date().toISOString(),
}

console.log('→ POST', TARGET)
console.log('→ phone =', phoneDigits, '| text =', JSON.stringify(text))

const r = await fetch(TARGET, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
const body = await r.text()
console.log(`\n← HTTP ${r.status}`)
console.log(body.slice(0, 800))
