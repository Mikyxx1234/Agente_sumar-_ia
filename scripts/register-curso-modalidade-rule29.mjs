/**
 * Registra regra 29 (curso + modalidade + MEC — não encaminhar consultor) no agent_rules.
 * Uso: node scripts/register-curso-modalidade-rule29.mjs [--dry-run]
 */
import fs from 'node:fs'
import { listActiveRules } from '../server/feedbackIA/rulesStore.js'

const DRY = process.argv.includes('--dry-run')
const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const RULE29_BODY = `29. CURSO + MODALIDADE + MEC — NÃO ENCAMINHAR CONSULTOR

    Quando o lead pedir informações sobre um curso (ex.: Pedagogia), valores, como se matricular, ou tiver dúvida sobre 100% online, MEC, EAD ou distância:
    a) OBRIGATÓRIO: buscar_conhecimento + buscar_precos para o curso citado e responder com modalidade, duração e mensalidade do CONTEXT.
    b) Se o CONTEXT disser Semipresencial: explique que combina estudo a distância com encontros presenciais agendados na Central Pinheiros — não prometa 100% EAD se não constar no CONTEXT.
    c) PROIBIDO distribuir_humano neste turno só por dúvida de modalidade/MEC/valores — essas informações estão na base.`

const r = await listActiveRules(env)
if (!r.ok) throw new Error(r.error || r.code)
if (r.data.some((x) => x.id === 29)) {
  console.log('regra 29: já existe')
  process.exit(0)
}

console.log('=== inserir regra 29 ===\n' + RULE29_BODY.slice(0, 400))
if (DRY) process.exit(0)

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
      id: 29,
      version: 1,
      title: 'Curso + modalidade + MEC — não encaminhar consultor',
      body: RULE29_BODY,
      updated_by: 'register_curso_modalidade_rule29',
    },
  ]),
})
console.log(`INSERT agent_rules 29 status=${ins.status}`)
if (ins.ok) {
  await fetch(`${U}/rest/v1/agent_rule_versions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify([
      {
        rule_id: 29,
        version: 1,
        body: RULE29_BODY,
        source: 'seed',
        applied_by: 'register_curso_modalidade_rule29',
      },
    ]),
  })
}
console.log('Concluído.')
