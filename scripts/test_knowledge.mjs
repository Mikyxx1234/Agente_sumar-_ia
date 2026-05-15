// Smoke test das 3 rotas /api/ai/knowledge/*.
// Usa fetch nativo + FormData/Blob (Node 18+).

const BASE = 'http://localhost:8000'

async function pretty(label, r) {
  const text = await r.text()
  let body = text
  try { body = JSON.stringify(JSON.parse(text), null, 2).slice(0, 800) } catch { body = text.slice(0, 800) }
  console.log(`\n=== ${label} ===\nHTTP ${r.status}\n${body}`)
}

// 1) STATS antes
{
  const r = await fetch(`${BASE}/api/ai/knowledge/stats`)
  await pretty('1) stats inicial', r)
}

// 2) UPLOAD de CSV de teste pra grad_preco
const csv = `curso,preco_mensal,duracao,modalidade
Administração,107.00,4 anos,EAD
Pedagogia,127.00,4 anos,EAD
Ciências Contábeis,127.00,4 anos,EAD
Engenharia de Software,167.00,4 anos,EAD
`
{
  const form = new FormData()
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'precos_teste.csv')
  form.append('table', 'grad_preco')
  const r = await fetch(`${BASE}/api/ai/knowledge/upload`, { method: 'POST', body: form })
  await pretty('2) upload CSV → grad_preco', r)
}

// 3) UPLOAD de TXT pra grad_info
const txt = `A Faculdade Sumaré é uma instituição de ensino superior brasileira, localizada na cidade de São Paulo.
Oferece cursos de graduação e pós-graduação em modalidade EAD (Ensino a Distância), com plataforma virtual acessível 24h por dia.

CURSOS DE GRADUAÇÃO (EAD)
- Administração: 4 anos, R$ 107/mês.
- Pedagogia: 4 anos, R$ 127/mês.
- Engenharia de Software: 4 anos, R$ 167/mês.

A instituição mantém polos em diversos estados do Brasil para provas presenciais.
`
{
  const form = new FormData()
  form.append('file', new Blob([txt], { type: 'text/plain' }), 'sobre_sumare.txt')
  form.append('table', 'grad_info')
  const r = await fetch(`${BASE}/api/ai/knowledge/upload`, { method: 'POST', body: form })
  await pretty('3) upload TXT → grad_info', r)
}

// 4) STATS depois
{
  const r = await fetch(`${BASE}/api/ai/knowledge/stats`)
  await pretty('4) stats após uploads', r)
}

// 5) CLEAR grad_preco
{
  const r = await fetch(`${BASE}/api/ai/knowledge/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: 'grad_preco' }),
  })
  await pretty('5) clear grad_preco', r)
}

// 6) STATS final
{
  const r = await fetch(`${BASE}/api/ai/knowledge/stats`)
  await pretty('6) stats final', r)
}
