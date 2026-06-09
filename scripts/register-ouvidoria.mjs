/**
 * Registra canal de Ouvidoria no RAG (grad_info/pos_info) e regra 27 no agent_rules.
 *
 * Uso: node scripts/register-ouvidoria.mjs [--dry-run]
 */
import fs from 'node:fs'
import { resolveModel } from '../server/ai/modelRegistry.js'
import { listActiveRules } from '../server/feedbackIA/rulesStore.js'

const DRY = process.argv.includes('--dry-run')
const OUVIDORIA_URL = 'https://sumare.edu.br/ouvidoria.html'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const RULE27_BODY = `27. OUVIDORIA — CANAL INSTITUCIONAL

    Quando o candidato pedir ouvidoria, reclamação formal à instituição, sugestão ou elogio institucional, ou quiser saber como falar com a Ouvidoria:
    a) Encaminhe o link oficial: ${OUVIDORIA_URL}
    b) Explique brevemente que na página há orientações de contato (e-mail ouvidoria@sumare.edu.br e informações para abrir o chamado).
    c) NÃO use distribuir_humano só por pedido de ouvidoria — o link é a resposta correta.
    d) Se for dúvida comercial comum (curso, preço, matrícula), responda normalmente; use esta regra quando o lead mencionar explicitamente ouvidoria ou canal formal de reclamação institucional.`

const FAQ_CONTENT = (nivel) =>
  [
    `assunto: ouvidoria — reclamação, sugestão, elogio institucional (${nivel})`,
    'palavras-chave: ouvidoria, falar com a ouvidoria, contato ouvidoria, reclamação formal, sugestão institucional, elogio à faculdade, canal de ouvidoria',
    '',
    'Para contato com a Ouvidoria do Centro Universitário Sumaré, acesse:',
    OUVIDORIA_URL,
    '',
    'Na página você encontra orientações de contato, incluindo o e-mail ouvidoria@sumare.edu.br.',
    'A Ouvidoria recebe reclamações, sugestões e elogios após os trâmites convencionais de atendimento.',
  ].join('\n')

async function embed(text) {
  const model = resolveModel(env, 'embeddings')
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY}` },
    body: JSON.stringify({ model, input: text }),
  })
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return (await r.json()).data[0].embedding
}

async function seedFaq() {
  const U = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const K = env.SUPABASE_KEY || ''
  const H = { apikey: K, Authorization: `Bearer ${K}` }
  const topic = 'ouvidoria_sumare'

  for (const { table, nivel } of [
    { table: 'grad_info', nivel: 'graduação' },
    { table: 'pos_info', nivel: 'pós-graduação' },
  ]) {
    const chk = await fetch(`${U}/rest/v1/${table}?select=id,content&metadata->>topic=eq.${topic}`, { headers: H })
    const rows = await chk.json()
    const content = FAQ_CONTENT(nivel)
    if (Array.isArray(rows) && rows.length > 0) {
      if (String(rows[0].content || '').includes(OUVIDORIA_URL)) {
        console.log(`FAQ ${table}/${topic}: já existe (id=${rows[0].id})`)
        continue
      }
      if (DRY) { console.log(`FAQ ${table}/${topic}: atualizaria id=${rows[0].id}`); continue }
      const embedding = await embed(content)
      await fetch(`${U}/rest/v1/${table}?id=eq.${rows[0].id}`, {
        method: 'PATCH',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, embedding, metadata: { kind: 'info_manual', topic, source: 'ouvidoria_2026', nivel, uploaded_at: new Date().toISOString() } }),
      })
      console.log(`FAQ ${table}/${topic}: atualizado id=${rows[0].id}`)
      continue
    }
    console.log(`FAQ ${table}/${topic}:\n${content}`)
    if (DRY) continue
    const maxR = await fetch(`${U}/rest/v1/${table}?select=id&order=id.desc&limit=1`, { headers: H })
    const maxRows = await maxR.json()
    const id = (Array.isArray(maxRows) && maxRows[0]?.id ? Number(maxRows[0].id) : 0) + 1
    const embedding = await embed(content)
    const ins = await fetch(`${U}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ id, content, embedding, metadata: { kind: 'info_manual', topic, source: 'ouvidoria_2026', nivel, uploaded_at: new Date().toISOString() } }),
    })
    console.log(`FAQ ${table}/${topic}: INSERT id=${id} status=${ins.status}`)
  }
}

async function seedRule27() {
  const r = await listActiveRules(env)
  if (!r.ok) throw new Error(r.error || r.code)
  if (r.data.some((x) => x.id === 27)) {
    console.log('regra 27: já existe')
    return
  }
  console.log('=== inserir regra 27 ===\n' + RULE27_BODY.slice(0, 400))
  if (DRY) return
  const U = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const K = env.SUPABASE_KEY || ''
  const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }
  const ins = await fetch(`${U}/rest/v1/agent_rules`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify([{ id: 27, version: 1, title: 'Ouvidoria — link institucional', body: RULE27_BODY, updated_by: 'register_ouvidoria' }]),
  })
  console.log(`INSERT agent_rules 27 status=${ins.status}`)
  if (ins.ok) {
    await fetch(`${U}/rest/v1/agent_rule_versions`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify([{ rule_id: 27, version: 1, body: RULE27_BODY, source: 'seed', applied_by: 'register_ouvidoria' }]),
    })
  }
}

console.log(DRY ? 'DRY-RUN\n' : 'Aplicando...\n')
await seedFaq()
await seedRule27()
console.log(DRY ? '\n[dry-run]' : '\nConcluído.')
