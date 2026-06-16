const BASE = process.argv[2] || 'http://127.0.0.1:8000'

const j = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { ok: false, raw: t.slice(0, 300) } }
}

async function turn(sessionId, telefone, message) {
  await j('/api/playground/push', { sessionId, message })
  const out = await j('/api/playground/flush', { sessionId, telefone, pushName: 'Teste QA' })
  const tools = (out.toolCalls || []).map((c) => c.tool || c.name || c.code).filter(Boolean)
  return { reply: out.reply || (out.ok ? '(sem reply)' : `ERRO: ${out.error || out.code || out.raw}`), tools }
}

async function conversa(nome, telefone, mensagens) {
  const sessionId = `${telefone}@s.whatsapp.net`
  console.log(`\n================ ${nome} (tel ${telefone}) ================`)
  for (const m of mensagens) {
    const { reply, tools } = await turn(sessionId, telefone, m)
    console.log(`\n👤 ${m}`)
    console.log(`🤖 ${reply}`)
    if (tools.length) console.log(`   [tools: ${tools.join(', ')}]`)
  }
}

await conversa('A — preço + valor até o fim + inscrição', '5511990000091', [
  'bom dia',
  'quanto custa o curso de Pedagogia?',
  'esse valor das mensalidades vale até o final do curso?',
  'quero me inscrever',
])

await conversa('B — modalidade (presencial?)', '5511990000092', [
  'o curso de Pedagogia é presencial?',
])

await conversa('C — curso fora do catálogo', '5511990000093', [
  'vocês têm o curso de Medicina?',
])

console.log('\n--- fim da simulação ---')
