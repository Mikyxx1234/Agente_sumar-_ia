/**
 * Registra regra 30 — grade curricular na base RAG.
 * Uso: node --env-file=.env scripts/register-grade-curricular-rule30.mjs
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

const RULE30_BODY = `30. GRADE CURRICULAR / DISCIPLINAS DO CURSO

    Quando o candidato perguntar grade curricular, matérias, disciplinas ou "o que vou aprender":
    a) Chame buscar_conhecimento incluindo nome do curso + modalidade + "grade curricular disciplinas".
    b) Use o CONTEXT (fonte grad_grade_curricular, grad_info ou pos_info com kind grade_curricular): cite exemplos de disciplinas e o total quando existir.
    c) Se pedir lista completa ou PDF: chame enviar_grade_pdf para gerar e enviar o PDF pelo WhatsApp. PROIBIDO dizer que não tem PDF quando a grade estiver no CONTEXT.
    d) PROIBIDO inventar disciplinas fora do CONTEXT.
    e) PROIBIDO encaminhar consultor (distribuir_humano) só por essa pergunta.`

async function main() {
  const r = await listActiveRules(env)
  if (!r.ok) throw new Error(r.error || r.code)
  if (r.data.some((x) => x.id === 30)) {
    console.log('regra 30: já existe')
    return
  }
  console.log('=== inserir regra 30 ===\n' + RULE30_BODY.slice(0, 400))
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
        id: 30,
        version: 1,
        title: 'Grade curricular — buscar disciplinas na base RAG',
        body: RULE30_BODY,
        updated_by: 'register_grade_curricular_rule30',
      },
    ]),
  })
  console.log(`INSERT agent_rules 30 status=${ins.status}`)
  if (ins.ok) {
    await fetch(`${U}/rest/v1/agent_rule_versions`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify([
        {
          rule_id: 30,
          version: 1,
          body: RULE30_BODY,
          source: 'seed',
          applied_by: 'register_grade_curricular_rule30',
        },
      ]),
    })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
