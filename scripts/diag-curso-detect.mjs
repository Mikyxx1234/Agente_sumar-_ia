import fs from 'node:fs'
const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const U = env.SUPABASE_URL.replace(/\/$/, '')
const K = env.SUPABASE_KEY
const H = { apikey: K, Authorization: 'Bearer ' + K }
const sid = encodeURIComponent('5511910144847@s.whatsapp.net')
const m = await fetch(`${U}/rest/v1/n8n_chat_histories?session_id=eq.${sid}&id=eq.87456&select=message`, { headers: H })
const j = await m.json()
const content = j[0].message?.data?.content || j[0].message?.content
console.log('TEXTO REDES:\n', content)

const { detectCursoConfirmadoPeloLead } = await import('../libShared/cursoConfirmation.js')
const { extractDiscussedCourseFromHistory } = await import('../libShared/conversationContextHeuristics.js')
const hist = [{ role: 'assistant', content }]
console.log('\n[REAL Redes] extractDiscussed:', JSON.stringify(extractDiscussedCourseFromHistory(hist)))
console.log('[REAL Redes] detectCurso("sim"):', JSON.stringify(detectCursoConfirmadoPeloLead('sim', hist)))

const cases = [
  ['O curso de graduação em Direito não é ofertado. Posso sugerir outros.', 'Direito? (deve falhar/ignorar)'],
  ['O curso de graduação em Administração está disponível na modalidade EAD, com foco em gestão de empresas e finanças.', 'Administração'],
  ['O curso de Pedagogia está disponível na modalidade EAD. Prepara para a docência.', 'Pedagogia'],
  ['O curso de tecnólogo em Análise e Desenvolvimento de Sistemas está disponível, com foco em redes e administração de bancos de dados.', 'ADS (não Redes/Adm)'],
]
console.log('\n--- casos sintéticos ---')
for (const [c, esperado] of cases) {
  console.log(`esperado=${esperado} ->`, JSON.stringify(extractDiscussedCourseFromHistory([{ role: 'assistant', content: c }])))
}
