/**
 * Atualiza regra 25 no DB: taxa de matrícula = primeira mensalidade (texto explicativo).
 *
 * Uso: node scripts/patch-rule-25-taxa-matricula.mjs [--dry-run]
 */
import fs from 'node:fs'
import { listActiveRules, applyRulePatch } from '../server/feedbackIA/rulesStore.js'

const DRY = process.argv.includes('--dry-run')
const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

function patchBody(body) {
  let b = String(body || '')
  if (b.includes('é a primeira mensalidade, no valor de')) return null
  b = b.replace(
    /- Taxa de matrícula: <mesmo valor da mensalidade>/,
    '- A taxa de matrícula é a primeira mensalidade, no valor de <valor da mensalidade com desconto>.',
  )
  b = b.replace(
    /- Taxa de matrícula = o MESMO valor de 1 mensalidade \(não invente outro valor\)\./,
    '- Taxa de matrícula = a primeira mensalidade (mesmo valor da mensalidade; não invente outro valor).',
  )
  return b
}

const r = await listActiveRules(env)
if (!r.ok) throw new Error(r.error || r.code)
const rule = r.data.find((x) => x.id === 25)
if (!rule) throw new Error('regra 25 não encontrada no DB')
const newBody = patchBody(rule.body)
if (!newBody || newBody === rule.body) {
  console.log('regra 25: já atualizada ou padrão não encontrado')
  process.exit(0)
}
console.log('=== novo corpo regra 25 ===\n' + newBody.slice(0, 700))
if (DRY) { console.log('\n[dry-run]'); process.exit(0) }
const res = await applyRulePatch(env, 25, { body: newBody, applied_by: 'patch_taxa_matricula', source: 'patch_approved' })
if (!res.ok) throw new Error(res.error || res.code)
console.log(`OK regra 25 → v${res.newVersion}`)
