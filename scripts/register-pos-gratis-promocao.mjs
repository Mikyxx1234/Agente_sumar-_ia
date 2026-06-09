/**
 * Registra promoção de Pós-Graduação 100% gratuita no RAG (grad_info/pos_info)
 * e regra 28 no agent_rules.
 *
 * Uso:
 *   node scripts/register-pos-gratis-promocao.mjs --dry-run
 *   node scripts/register-pos-gratis-promocao.mjs
 */
import fs from 'node:fs'
import { resolveModel } from '../server/ai/modelRegistry.js'
import { listActiveRules } from '../server/feedbackIA/rulesStore.js'

const DRY = process.argv.includes('--dry-run')
const TOPIC = 'pos_gratis_promocao'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const RULE28_BODY = `28. PROMOÇÃO PÓS-GRADUAÇÃO 100% GRATUITA AO FINAL DA GRADUAÇÃO

    Quando o candidato perguntar sobre a promoção de Pós-Graduação 100% gratuita (ex.: "pós grátis ao final", "me passaram que tem pós grátis", "mais uma pós grátis"):
    a) Confirme que a promoção existe conforme campanha vigente — NÃO diga que "não consta na base".
    b) Explique: após concluir o curso de graduação, o aluno tem 30 (trinta) dias para entrar em contato com a Central da Faculdade Sumaré e solicitar a Pós-Graduação gratuita.
    c) Chame buscar_conhecimento com query "pós-graduação 100% gratuita promoção 30 dias central" se precisar confirmar no CONTEXT.
    d) PROIBIDO encaminhar consultor (distribuir_humano) só por essa pergunta — a informação está na base institucional.`

function buildFaqContent(nivel) {
  return [
    `assunto: promoção pós-graduação 100% gratuita ao final do curso (${nivel})`,
    'palavras-chave: pós grátis, pós gratuita, pós 100% grátis, pós-graduação gratuita, promoção pós, ganhar pós, pós grátis ao final, me passaram pós grátis, mais uma pós grátis, pós 100% gratuita',
    '',
    'PROMOÇÃO PÓS-GRADUAÇÃO 100% GRATUITA:',
    '',
    'Existe promoção de Pós-Graduação 100% gratuita ao final do curso de graduação, conforme campanha vigente da Faculdade Sumaré.',
    '',
    'PROCEDIMENTO:',
    'Após o candidato concluir a graduação, ele tem 30 (trinta) dias para entrar em contato com a Central da Faculdade Sumaré e solicitar a Pós-Graduação gratuita.',
    '',
    'Quando o candidato questionar essa promoção, confirme que ela existe e informe o prazo de 30 dias após a conclusão do curso para solicitar à Central.',
  ].join('\n')
}

async function embed(text) {
  const model = resolveModel(env, 'embeddings')
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, input: text }),
  })
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return (await r.json()).data[0].embedding
}

async function seedFaq() {
  const U = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const K = env.SUPABASE_KEY || ''
  const H = { apikey: K, Authorization: `Bearer ${K}` }

  for (const { table, nivel } of [
    { table: 'grad_info', nivel: 'graduação' },
    { table: 'pos_info', nivel: 'pós-graduação' },
  ]) {
    const chk = await fetch(`${U}/rest/v1/${table}?select=id,content&metadata->>topic=eq.${TOPIC}`, { headers: H })
    const rows = await chk.json()
    const content = buildFaqContent(nivel)

    if (Array.isArray(rows) && rows.length > 0) {
      if (String(rows[0].content || '').includes('30 (trinta) dias')) {
        console.log(`FAQ ${table}/${TOPIC}: já existe (id=${rows[0].id})`)
        continue
      }
      if (DRY) {
        console.log(`FAQ ${table}/${TOPIC}: atualizaria id=${rows[0].id}`)
        continue
      }
      const embedding = await embed(content)
      await fetch(`${U}/rest/v1/${table}?id=eq.${rows[0].id}`, {
        method: 'PATCH',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          embedding,
          metadata: {
            kind: 'info_manual',
            topic: TOPIC,
            source: 'pos_gratis_promocao_2026',
            nivel,
            uploaded_at: new Date().toISOString(),
          },
        }),
      })
      console.log(`FAQ ${table}/${TOPIC}: atualizado id=${rows[0].id}`)
      continue
    }

    console.log(`FAQ ${table}/${TOPIC}:\n${content}\n`)
    if (DRY) continue

    const maxR = await fetch(`${U}/rest/v1/${table}?select=id&order=id.desc&limit=1`, { headers: H })
    const maxRows = await maxR.json()
    const id = (Array.isArray(maxRows) && maxRows[0]?.id ? Number(maxRows[0].id) : 0) + 1
    const embedding = await embed(content)
    const ins = await fetch(`${U}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        id,
        content,
        embedding,
        metadata: {
          kind: 'info_manual',
          topic: TOPIC,
          source: 'pos_gratis_promocao_2026',
          nivel,
          uploaded_at: new Date().toISOString(),
        },
      }),
    })
    const body = await ins.text()
    console.log(`FAQ ${table}/${TOPIC}: INSERT id=${id} status=${ins.status} ${ins.ok ? 'ok' : body.slice(0, 200)}`)
  }
}

async function seedRule28() {
  const r = await listActiveRules(env)
  if (!r.ok) throw new Error(r.error || r.code)
  if (r.data.some((x) => x.id === 28)) {
    console.log('regra 28: já existe')
    return
  }
  console.log('=== inserir regra 28 ===\n' + RULE28_BODY.slice(0, 400))
  if (DRY) return
  const U = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const K = env.SUPABASE_KEY || ''
  const H = {
    apikey: K,
    Authorization: `Bearer ${K}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
  const ins = await fetch(`${U}/rest/v1/agent_rules`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify([
      {
        id: 28,
        version: 1,
        title: 'Promoção pós-graduação 100% gratuita — 30 dias após conclusão',
        body: RULE28_BODY,
        updated_by: 'register_pos_gratis_promocao',
      },
    ]),
  })
  console.log(`INSERT agent_rules 28 status=${ins.status}`)
  if (ins.ok) {
    await fetch(`${U}/rest/v1/agent_rule_versions`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify([
        {
          rule_id: 28,
          version: 1,
          body: RULE28_BODY,
          source: 'seed',
          applied_by: 'register_pos_gratis_promocao',
        },
      ]),
    })
  }
}

console.log(DRY ? 'DRY-RUN\n' : 'Aplicando...\n')
await seedFaq()
await seedRule28()
console.log(DRY ? '\n[dry-run]' : '\nConcluído.')
