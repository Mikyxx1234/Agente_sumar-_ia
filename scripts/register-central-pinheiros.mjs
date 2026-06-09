/**
 * Registra a Central Pinheiros como local oficial de atendimento e aulas presenciais:
 *   - FAQ RAG (grad_info + pos_info, topic central_presencial)
 *   - agent_rules 6 e 18 (patch)
 *   - agent_rules 26 (nova regra, idempotente)
 *
 * Uso:
 *   node scripts/register-central-pinheiros.mjs --dry-run
 *   node scripts/register-central-pinheiros.mjs
 */
import fs from 'node:fs'
import { resolveModel } from '../server/ai/modelRegistry.js'
import { listActiveRules, applyRulePatch } from '../server/feedbackIA/rulesStore.js'

const DRY = process.argv.includes('--dry-run')
const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const CENTRAL_LINE = 'Rua Alegrete, 89, Sumaré, São Paulo/SP.'

const RULE6_SNIPPET = `   Quando o lead perguntar endereço/unidade/polo para atendimento ou aulas presenciais, informe a Central em Pinheiros (${CENTRAL_LINE}) — ver regra 18/26.
   NÃO use tool de localização nem calcule distância/tempo de deslocamento automaticamente.`

const RULE18_BODY = `18. COBERTURA GEOGRÁFICA E LOCAL DA CENTRAL.
    Atualmente, TODO o atendimento presencial e as aulas presenciais (incluindo cursos Semipresenciais) ocorrem na Central da Faculdade Sumaré em Pinheiros:
    ${CENTRAL_LINE}

    Quando o lead perguntar onde fica o polo/unidade/campus mais próximo, endereço para ir presencialmente ou "tem polo em [cidade/bairro]?":
    a) Informe CLARAMENTE o endereço da Central acima — essa É a localização oficial para atendimento e encontros presenciais hoje.
    b) NÃO diga que "não temos polo" ou "não temos unidade na região" sem antes informar a Central em Pinheiros.
    c) NÃO encaminhe para consultor (distribuir_humano) SÓ porque o lead perguntou localização/endereço — use buscar_conhecimento ou buscar_perguntas.
    d) Se o lead mora longe, reconheça com empatia; cursos EAD são 100% a distância; nos Semipresenciais os encontros presenciais são na Central indicada.

    Para matrícula em outras cidades/estados, não afirme cobertura sem estar no CONTEXT — mas pergunta de ONDE IR PRESENCIALMENTE sempre tem resposta: Central Pinheiros no endereço acima.`

const RULE26_BODY = `26. CENTRAL PINHEIROS — ENDEREÇO OFICIAL (reforço da regra 18)

    Informação institucional fixa (não invente outro endereço):
    - Todo atendimento presencial e todas as aulas presenciais ocorrem na Central em Pinheiros.
    - Endereço: ${CENTRAL_LINE}

    Se o lead citar cidade/bairro distante (ex.: Itapecerica da Serra, Embu-Guaçu, interior), responda com o endereço da Central e explique que é o ponto oficial hoje — não encaminhe consultor só por isso.`

const FAQ_TOPICS = [
  {
    topic: 'central_presencial',
    content: (nivel) =>
      [
        `assunto: onde fica a Sumaré — endereço, unidade/campus, polo, atendimento e aulas presenciais (${nivel})`,
        'palavras-chave: onde fica, endereço, localização, unidade, campus, polo, tem polo, polo mais próximo, aulas presenciais, atendimento presencial, Pinheiros, Rua Alegrete, Itapecerica, Embu-Guaçu, São Paulo',
        '',
        'Atualmente, todo o atendimento e as aulas presenciais ocorrem na nossa Central, em Pinheiros:',
        CENTRAL_LINE,
      ].join('\n'),
  },
]

function patchRule6Body(body) {
  const b = String(body || '')
  if (b.includes('Rua Alegrete, 89')) return null
  const replaced = b.replace(
    /NÃO ofereça buscar polo, distância, endereço de unidade nem tempo de deslocamento[^\n]*/i,
    RULE6_SNIPPET,
  )
  return replaced !== b ? replaced : `${b.trimEnd()}\n${RULE6_SNIPPET}`
}

function patchRule18Body(body) {
  const b = String(body || '')
  if (b.includes('Rua Alegrete, 89') && b.includes('COBERTURA GEOGRÁFICA E LOCAL DA CENTRAL')) return null
  return RULE18_BODY
}

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
  if (!U || !K) throw new Error('SUPABASE_URL/KEY ausentes')

  for (const { table, nivel } of [
    { table: 'grad_info', nivel: 'graduação' },
    { table: 'pos_info', nivel: 'pós-graduação' },
  ]) {
    for (const t of FAQ_TOPICS) {
      const chk = await fetch(`${U}/rest/v1/${table}?select=id,content&metadata->>topic=eq.${t.topic}`, { headers: H })
      const rows = await chk.json()
      const content = t.content(nivel)
      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0]
        if (String(row.content || '').includes('Rua Alegrete, 89')) {
          console.log(`FAQ ${table}/${t.topic}: já atualizado (id=${row.id})`)
          continue
        }
        console.log(`FAQ ${table}/${t.topic}: atualizando id=${row.id}`)
        if (DRY) continue
        const embedding = await embed(content)
        const upd = await fetch(`${U}/rest/v1/${table}?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ content, embedding, metadata: { kind: 'info_manual', topic: t.topic, source: 'central_pinheiros_2026', nivel, uploaded_at: new Date().toISOString() } }),
        })
        console.log(`  PATCH status=${upd.status}`)
        continue
      }
      console.log(`FAQ ${table}/${t.topic}: inserindo\n${content}`)
      if (DRY) continue
      const maxR = await fetch(`${U}/rest/v1/${table}?select=id&order=id.desc&limit=1`, { headers: H })
      const maxRows = await maxR.json()
      const id = (Array.isArray(maxRows) && maxRows[0]?.id ? Number(maxRows[0].id) : 0) + 1
      const embedding = await embed(content)
      const ins = await fetch(`${U}/rest/v1/${table}`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ id, content, embedding, metadata: { kind: 'info_manual', topic: t.topic, source: 'central_pinheiros_2026', nivel, uploaded_at: new Date().toISOString() } }),
      })
      console.log(`  INSERT id=${id} status=${ins.status}`)
    }
  }
}

async function patchRules() {
  const r = await listActiveRules(env)
  if (!r.ok) throw new Error(`listActiveRules: ${r.error || r.code}`)
  const byId = new Map(r.data.map((x) => [x.id, x]))

  for (const [id, transform] of [
    [6, patchRule6Body],
    [18, patchRule18Body],
  ]) {
    const rule = byId.get(id)
    if (!rule) { console.warn(`! regra ${id} não encontrada`); continue }
    const newBody = transform(rule.body)
    if (!newBody || newBody === rule.body) {
      console.log(`regra ${id}: já OK ou sem mudança`)
      continue
    }
    console.log(`\n=== patch regra ${id} (${rule.title}) ===`)
    console.log(newBody.slice(0, 500))
    if (DRY) continue
    const res = await applyRulePatch(env, id, { body: newBody, applied_by: 'register_central_pinheiros', source: 'patch_approved' })
    if (!res.ok) console.error(`  ERRO: ${res.error || res.code}`)
    else console.log(`  OK → v${res.newVersion}`)
  }

  const rule26 = byId.get(26)
  if (rule26) {
    console.log('\nregra 26: já existe')
    return
  }
  console.log('\n=== inserir regra 26 ===')
  console.log(RULE26_BODY.slice(0, 400))
  if (DRY) return
  const U = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const K = env.SUPABASE_KEY || ''
  const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }
  const ins = await fetch(`${U}/rest/v1/agent_rules`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify([{ id: 26, version: 1, title: 'Central Pinheiros — endereço oficial presencial', body: RULE26_BODY, updated_by: 'register_central_pinheiros' }]),
  })
  console.log(`INSERT agent_rules 26 status=${ins.status}`)
  if (ins.ok) {
    await fetch(`${U}/rest/v1/agent_rule_versions`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify([{ rule_id: 26, version: 1, body: RULE26_BODY, source: 'seed', applied_by: 'register_central_pinheiros' }]),
    })
  }
}

async function main() {
  console.log(DRY ? 'DRY-RUN\n' : 'Aplicando...\n')
  await seedFaq()
  await patchRules()
  console.log(DRY ? '\n[dry-run] nada gravado.' : '\nConcluído. Reinicie o serviço ou aguarde refresh do cache de regras (~5 min).')
}

main().catch((e) => { console.error(e); process.exit(1) })
