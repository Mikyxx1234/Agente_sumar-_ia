const BASE = process.argv[2] || 'http://127.0.0.1:8000'
const j = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try { return JSON.parse(await r.text()) } catch { return { ok: false } }
}
async function turn(sessionId, telefone, message) {
  await j('/api/playground/push', { sessionId, message })
  const out = await j('/api/playground/flush', { sessionId, telefone, pushName: 'Teste QA' })
  const tools = (out.toolCalls || []).map((c) => c.tool || c.name || c.code).filter(Boolean)
  return { reply: out.reply || `ERRO:${out.error || out.code || ''}`, tools }
}
async function conversa(nome, telefone, mensagens) {
  const sessionId = `${telefone}@s.whatsapp.net`
  console.log(`\n================ ${nome} ================`)
  for (const m of mensagens) {
    const { reply, tools } = await turn(sessionId, telefone, m)
    console.log(`\n👤 ${m}\n🤖 ${reply}`)
    if (tools.length) console.log(`   [tools: ${tools.join(', ')}]`)
  }
}

// 1) MEDICINA — regressão (3x)
console.log('================ MEDICINA (regressão) ================')
for (let i = 0; i < 3; i++) {
  const tel = `551199000${850 + i}`
  const { reply } = await turn(`${tel}@s.whatsapp.net`, tel, 'vocês têm o curso de Medicina?')
  const t = reply.toLowerCase()
  const v = /não (faz parte|consta|temos|oferece)|não.*cat[aá]logo/.test(t) ? 'OK ✅' : 'RUIM ❌'
  console.log(`#${i + 1} ${v} :: ${reply.replace(/\s+/g, ' ').slice(0, 130)}`)
}

// 2) APROVEITAMENTO / TRANSFERÊNCIA — 3 frases coloquiais
console.log('\n================ APROVEITAMENTO/TRANSFERÊNCIA (3 variações) ================')
const aprov = [
  'já cursei 2 anos de outra faculdade, consigo aproveitar as matérias?',
  'estudei direito em outra faculdade e quero continuar aqui, dá pra aproveitar?',
  'tô vindo de outra faculdade, consigo aproveitar o que já fiz?',
]
for (let i = 0; i < aprov.length; i++) {
  const tel = `551199000${860 + i}`
  const { reply, tools } = await turn(`${tel}@s.whatsapp.net`, tel, aprov[i])
  const human = tools.includes('distribuir_humano') || /seguir o atendimento por aqui|prefere.*direcionar/i.test(reply)
  console.log(`#${i + 1} ${human ? 'RUIM ❌ (humano)' : 'OK ✅ (comercial)'} [${tools.join(',') || 'sem tools'}] :: ${reply.replace(/\s+/g, ' ').slice(0, 120)}`)
}

// 3) PÓS-GRADUAÇÃO
await conversa('PÓS-GRADUAÇÃO', '5511990000870', ['tem pós em psicologia?', 'quanto custa?'])

// 4) NOVO: ALUNO ATUAL com dúvida acadêmica
await conversa('ALUNO ATUAL — dúvida acadêmica', '5511990000871', [
  'oi, eu já sou aluno da Sumaré e quero trancar minha matrícula, como faço?',
])
await conversa('ALUNO ATUAL — documento', '5511990000872', [
  'sou aluno e preciso da minha declaração de matrícula',
])
await conversa('ALUNO ATUAL — financeiro', '5511990000873', [
  'já estudo aí e estou com a mensalidade atrasada, como regularizo?',
])

console.log('\n--- fim ---')
