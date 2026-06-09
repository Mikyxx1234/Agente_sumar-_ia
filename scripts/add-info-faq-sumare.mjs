/**
 * Adiciona FAQs institucionais em grad_info e pos_info (1 linha por tópico/tabela):
 *   - central_presencial : endereço/Central em Pinheiros (atendimento e aulas presenciais)
 *   - reajuste_anual      : desconto mantido até o fim do curso; reajuste 8–12%/ano
 *   - rematricula_sem_taxa: Sumaré não cobra taxa de rematrícula
 *   - ouvidoria_sumare    : link e contato da Ouvidoria institucional
 *
 * Aditivo, reversível e idempotente (metadata.topic). Embedding text-embedding-3-small (1536).
 *
 * Uso:
 *   node --env-file=.env scripts/add-info-faq-sumare.mjs --dry-run
 *   node --env-file=.env scripts/add-info-faq-sumare.mjs
 */
import { resolveModel } from '../server/ai/modelRegistry.js'

const DRY = process.argv.includes('--dry-run')
const env = process.env
const U = (env.SUPABASE_URL || '').replace(/\/$/, '')
const K = env.SUPABASE_KEY || ''
const H = { apikey: K, Authorization: `Bearer ${K}` }

const TOPICS = [
  {
    topic: 'central_presencial',
    content: (nivel) =>
      [
        `assunto: onde fica a Sumaré — endereço, unidade/campus, atendimento e aulas presenciais (${nivel})`,
        'palavras-chave: onde fica, endereço, localização, unidade, campus, polo, tem polo, aulas presenciais, atendimento presencial, Pinheiros, Rua Alegrete, São Paulo',
        '',
        'Atualmente, todo o atendimento e as aulas presenciais ocorrem na nossa Central, em Pinheiros:',
        'Rua Alegrete, 89, Sumaré, São Paulo/SP.',
      ].join('\n'),
  },
  {
    topic: 'reajuste_anual',
    content: (nivel) =>
      [
        `assunto: o desconto/valor da mensalidade se mantém — reajuste anual (${nivel})`,
        'palavras-chave: o desconto continua, vou pagar esse valor até o fim do curso, o valor aumenta, a mensalidade sobe, tem reajuste, reajuste anual, aumento de preço',
        '',
        'O desconto especial que estamos oferecendo é mantido até o final do seu curso. Ocorre apenas um pequeno reajuste anual, de 8% a 12% ao ano.',
      ].join('\n'),
  },
  {
    topic: 'rematricula_sem_taxa',
    content: (nivel) =>
      [
        `assunto: rematrícula sem taxa — não há cobrança adicional para renovar a matrícula (${nivel})`,
        'palavras-chave: taxa de rematrícula, paga rematrícula, custo de rematrícula, cobra para renovar matrícula, tem que pagar rematrícula a cada semestre',
        '',
        'A Sumaré não cobra valor adicional de rematrícula. Você paga somente as mensalidades.',
      ].join('\n'),
  },
  {
    topic: 'ouvidoria_sumare',
    content: (nivel) =>
      [
        `assunto: ouvidoria — reclamação, sugestão, elogio institucional (${nivel})`,
        'palavras-chave: ouvidoria, falar com a ouvidoria, contato ouvidoria, reclamação formal, sugestão institucional, elogio à faculdade',
        '',
        'Para contato com a Ouvidoria do Centro Universitário Sumaré, acesse:',
        'https://sumare.edu.br/ouvidoria.html',
        '',
        'Na página você encontra orientações de contato, incluindo o e-mail ouvidoria@sumare.edu.br.',
      ].join('\n'),
  },
]

const TABLES = [
  { table: 'grad_info', nivel: 'graduação' },
  { table: 'pos_info', nivel: 'pós-graduação' },
]

async function embed(text) {
  const model = resolveModel(env, 'embeddings')
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY}` },
    body: JSON.stringify({ model, input: text }),
  })
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const emb = (await r.json()).data[0].embedding
  if (emb.length !== 1536) console.warn(`AVISO: embedding ${emb.length} dims`)
  return emb
}
async function maxId(table) {
  const r = await fetch(`${U}/rest/v1/${table}?select=id&order=id.desc&limit=1`, { headers: H })
  const rows = await r.json()
  return Array.isArray(rows) && rows[0]?.id ? Number(rows[0].id) : 0
}
async function topicExists(table, topic) {
  const r = await fetch(`${U}/rest/v1/${table}?select=id&metadata->>topic=eq.${topic}`, { headers: H })
  const rows = await r.json()
  return Array.isArray(rows) && rows.length > 0 ? rows.map((x) => x.id) : []
}
async function insertRow(table, row) {
  const r = await fetch(`${U}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  })
  return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 300) }
}

async function main() {
  if (!U || !K) throw new Error('SUPABASE_URL/KEY ausentes')
  console.log(DRY ? 'DRY-RUN\n' : 'Inserindo...\n')
  for (const { table, nivel } of TABLES) {
    let nextId = (await maxId(table)) + 1
    for (const t of TOPICS) {
      const exists = await topicExists(table, t.topic)
      if (exists.length) { console.log(`-- ${table}/${t.topic}: já existe (id=${exists.join(',')}), pulando`); continue }
      const content = t.content(nivel)
      const metadata = { kind: 'info_manual', topic: t.topic, source: 'faq_institucional_2026', nivel, uploaded_at: new Date().toISOString() }
      console.log(`-- ${table}/${t.topic} --\n${content}`)
      if (DRY) { console.log('[dry-run]\n'); continue }
      const embedding = await embed(content)
      const id = nextId++
      const res = await insertRow(table, { id, content, embedding, metadata })
      console.log(`INSERT id=${id} status=${res.status} ok=${res.ok}${res.ok ? '' : ' :: ' + res.body}\n`)
    }
  }
  console.log(DRY ? '\n[dry-run] nada gravado.' : '\nConcluído.')
}

main().catch((e) => { console.error(e); process.exit(1) })
