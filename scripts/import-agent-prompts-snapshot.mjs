/**
 * Aplica snapshot JSON nos prompts do Supabase configurado no .env.
 * Só sobrescreve prompts existentes quando --force; senão só insere faltantes.
 *
 * Uso:
 *   node --env-file=.env scripts/import-agent-prompts-snapshot.mjs [jsonFile] [--force]
 */
import { readFileSync } from 'node:fs'
import { countAgentPrompts, seedPrompts, applyPromptPatch } from '../server/feedbackIA/promptsStore.js'

const args = process.argv.slice(2)
const force = args.includes('--force')
const jsonFile = args.find((a) => !a.startsWith('--')) || 'scripts/data/agent-prompts-snapshot.json'
const snap = JSON.parse(readFileSync(jsonFile, 'utf8'))
const prompts = snap.prompts || []
if (!prompts.length) {
  console.error('Snapshot vazio:', jsonFile)
  process.exit(1)
}

const count = await countAgentPrompts(process.env)
if (!count.ok && count.code === 'TABLE_MISSING') {
  console.error('Tabela agent_prompts ausente. Rode: npm run db:ensure-agent-prompts')
  process.exit(2)
}

const seed = await seedPrompts(process.env, prompts.map((p) => ({
  prompt_id: p.prompt_id,
  node_name: p.node_name,
  node_type: p.node_type,
  body: p.body,
})))
console.log(`Seed: inserted=${seed.inserted} skipped=${seed.skipped}`)

if (force) {
  for (const p of prompts) {
    const r = await applyPromptPatch(process.env, p.prompt_id, {
      body: p.body,
      node_name: p.node_name,
      node_type: p.node_type,
      applied_by: 'import-snapshot',
    })
    console.log(`apply ${p.node_name}: ok=${r.ok} v=${r.newVersion ?? 'n/a'}`)
  }
}

console.log('Import concluído.')
