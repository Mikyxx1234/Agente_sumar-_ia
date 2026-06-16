/**
 * Exporta os prompts efetivos (base + overrides do DB) para JSON.
 * Uso: node --env-file=.env scripts/export-agent-prompts-snapshot.mjs [outFile]
 */
import { writeFileSync } from 'node:fs'
import { loadBasePrompts } from '../server/ai/promptsLoader.js'
import { listPromptOverrides } from '../server/feedbackIA/promptsStore.js'

const outFile = process.argv[2] || 'scripts/data/agent-prompts-snapshot.json'
const base = await loadBasePrompts()
const ov = await listPromptOverrides(process.env)
const map = new Map()
if (ov.ok) for (const row of ov.data) map.set(row.prompt_id, row)

const prompts = base.map((p) => {
  const o = map.get(p.id)
  return {
    prompt_id: p.id,
    node_name: p.name,
    node_type: p.type,
    body: o?.body ?? p.body,
    version: o?.version ?? 0,
    overridden: Boolean(o),
  }
})

writeFileSync(outFile, JSON.stringify({ exportedAt: new Date().toISOString(), prompts }, null, 2), 'utf8')
console.log(`Exportados ${prompts.length} prompts → ${outFile}`)
for (const p of prompts) {
  console.log(`  ${p.node_name} v${p.version} overridden=${p.overridden} len=${p.body.length}`)
}
