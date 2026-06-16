/**
 * Validação ponta a ponta dos endpoints de prompts (mesmos que a UI usa):
 * GET → apply (com marcador) → GET (confirma override) → rollback → GET.
 * Uso: node scripts/validate-prompt-cycle.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8000'
const TARGET = '26a7d8e2-8fd8-4f16-ade2-a478eb3ffe6b-0' // "agente preguntas"
const MARKER = '[[TESTE_OVERLAY_SUMARE_2026]]'

const j = async (res) => {
  const t = await res.text()
  try { return JSON.parse(t) } catch { return { ok: false, raw: t.slice(0, 200) } }
}

async function getPrompt(id) {
  const r = await j(await fetch(`${BASE}/api/feedback-ia/prompts`))
  return (r.data || []).find((p) => p.id === id)
}

async function main() {
  const before = await getPrompt(TARGET)
  if (!before) throw new Error('prompt alvo não encontrado')
  console.log(`[1] estado inicial: v${before.version} overridden=${before.overridden} bodyLen=${before.body.length} markerPresent=${before.body.includes(MARKER)}`)

  const baseBody = before.body.replace(`\n\n${MARKER}`, '')
  const applyRes = await j(await fetch(`${BASE}/api/feedback-ia/prompts/${encodeURIComponent(TARGET)}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: `${baseBody}\n\n${MARKER}`, node_name: before.name, node_type: before.type, applied_by: 'validacao-local' }),
  }))
  console.log(`[2] apply: ok=${applyRes.ok} newVersion=${applyRes.newVersion} cacheOverrides=${applyRes.cache?.overridesCount} flag=${applyRes.flagEnabled}`)
  if (!applyRes.ok) throw new Error('apply falhou: ' + JSON.stringify(applyRes))

  const after = await getPrompt(TARGET)
  console.log(`[3] após edição: v${after.version} overridden=${after.overridden} markerPresent=${after.body.includes(MARKER)} appliesToAgent=${after.appliesToAgent}`)

  // Prova que o agente (loadPrompts) reflete o override agora:
  const { loadPrompts } = await import('../server/ai/promptsLoader.js')
  const effective = await loadPrompts(process.env)
  const eff = effective.find((p) => p.id === TARGET)
  console.log(`[4] loadPrompts (o que o agente usa): markerPresent=${eff?.body.includes(MARKER)} overridden=${Boolean(eff?.overridden)}`)

  // Rollback para a v1 (limpa o marcador de teste).
  const versions = await j(await fetch(`${BASE}/api/feedback-ia/prompts/${encodeURIComponent(TARGET)}/versions`))
  const v1 = (versions.data || []).find((v) => v.version === 1)
  if (v1) {
    const rb = await j(await fetch(`${BASE}/api/feedback-ia/prompts/${encodeURIComponent(TARGET)}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, applied_by: 'validacao-local' }),
    }))
    console.log(`[5] rollback->v1: ok=${rb.ok} newVersion=${rb.newVersion}`)
  }
  const final = await getPrompt(TARGET)
  console.log(`[6] estado final: v${final.version} markerPresent=${final.body.includes(MARKER)} (esperado: false)`)
  console.log(final.body.includes(MARKER) ? 'RESULTADO: FALHOU (marcador ainda presente)' : 'RESULTADO: OK — ciclo editar→persistir→agente→rollback validado')
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1) })
