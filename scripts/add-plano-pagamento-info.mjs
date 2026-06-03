/**
 * Adiciona (1 linha por tabela) a informação do "Plano de Benefício para
 * Pagamento Antecipado Facultativo" em grad_info e pos_info — para o agente
 * responder quando o candidato perguntar quais dias pode pagar a mensalidade
 * (e os descontos por pagamento antecipado).
 *
 * Aditivo e reversível (metadata.kind = 'info_manual', topic = 'pagamento_antecipado').
 * Gera embedding com o mesmo modelo do RAG (text-embedding-3-small / 1536 dims).
 *
 * Uso:
 *   node --env-file=.env scripts/add-plano-pagamento-info.mjs --dry-run
 *   node --env-file=.env scripts/add-plano-pagamento-info.mjs
 */

import { resolveModel } from '../server/ai/modelRegistry.js'

const DRY_RUN = process.argv.includes('--dry-run')
const env = { ...process.env }
const URL = (env.SUPABASE_URL || '').replace(/\/$/, '')
const KEY = env.SUPABASE_KEY || ''

function buildContent(nivel) {
  return [
    `assunto: pagamento da mensalidade — quais dias pagar e descontos por pagamento antecipado (${nivel})`,
    'palavras-chave: quando pagar a mensalidade, quais dias posso pagar, dia de vencimento, desconto por pagamento antecipado facultativo, pagar antes, desconto de 70% 50% 20%',
    '',
    'PLANO DE BENEFÍCIO PARA PAGAMENTO ANTECIPADO FACULTATIVO:',
    '',
    'O valor do curso terá desconto por pagamento antecipado facultativo em cada parcela, respeitadas as seguintes condições e proporcionalidade:',
    '',
    'a) 1º (primeiro) dia do mês: 70% (setenta por cento) de desconto;',
    'b) do 2º (segundo) ao 5º (quinto) dia do mês: 50% (cinquenta por cento) de desconto, contabilizando, inclusive, o sábado;',
    'c) do 6º (sexto) ao 10º (décimo) dia do mês: 20% (vinte por cento) de desconto.',
    '',
    'ATENÇÃO: após o dia 10 (dez) do mês de referência até o último dia do mês, NÃO haverá desconto por pagamento antecipado aplicável no valor da mensalidade contratada.',
    '',
    `Aplica-se aos cursos de ${nivel} EAD da Faculdade Sumaré.`,
  ].join('\n')
}

const TARGETS = [
  { table: 'grad_info', nivel: 'graduação' },
  { table: 'pos_info', nivel: 'pós-graduação' },
]

async function embed(text) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY ausente')
  const model = resolveModel(env, 'embeddings')
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: text }),
  })
  if (!r.ok) throw new Error(`OpenAI embeddings ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  const emb = data.data[0].embedding
  if (emb.length !== 1536) console.warn(`AVISO: embedding tem ${emb.length} dims (esperado 1536)`)
  return emb
}

async function maxId(table) {
  const r = await fetch(`${URL}/rest/v1/${table}?select=id&order=id.desc&limit=1`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  const rows = await r.json()
  return Array.isArray(rows) && rows[0]?.id ? Number(rows[0].id) : 0
}

async function alreadyExists(table) {
  const r = await fetch(
    `${URL}/rest/v1/${table}?select=id,metadata&metadata->>topic=eq.pagamento_antecipado`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
  )
  const rows = await r.json()
  return Array.isArray(rows) ? rows : []
}

async function insertRow(table, row) {
  const r = await fetch(`${URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  })
  const text = await r.text()
  return { ok: r.ok, status: r.status, body: text.slice(0, 400) }
}

async function main() {
  if (!URL || !KEY) throw new Error('SUPABASE_URL/KEY ausentes')
  console.log(DRY_RUN ? 'MODO DRY-RUN (sem INSERT)\n' : 'Inserindo linhas...\n')

  for (const { table, nivel } of TARGETS) {
    const existing = await alreadyExists(table)
    if (existing.length > 0) {
      console.log(`── ${table}: JÁ EXISTE linha topic=pagamento_antecipado (id=${existing.map((e) => e.id).join(',')}). Pulando.`)
      continue
    }
    const content = buildContent(nivel)
    const metadata = {
      kind: 'info_manual',
      topic: 'pagamento_antecipado',
      source: 'plano_beneficio_pagamento_antecipado',
      nivel,
      uploaded_at: new Date().toISOString(),
    }
    console.log(`── ${table} (${nivel}) ──`)
    console.log(content)
    console.log('metadata:', JSON.stringify(metadata))
    if (DRY_RUN) {
      console.log('[dry-run] embedding seria gerado e a linha inserida.\n')
      continue
    }
    const embedding = await embed(content)
    const id = (await maxId(table)) + 1
    const res = await insertRow(table, { id, content, embedding, metadata })
    console.log(`INSERT id=${id} status=${res.status} ok=${res.ok}`)
    if (!res.ok) console.log('  erro:', res.body)
    console.log()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
