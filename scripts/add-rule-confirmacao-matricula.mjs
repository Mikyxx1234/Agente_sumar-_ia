/**
 * Insere a REGRA 25 ("Confirmação antes da matrícula — resumo + autorização")
 * na tabela `agent_rules` (e espelha em `agent_rule_versions`).
 *
 * O prompt ativo vem do DB (composeOverrideFromDB), então a regra precisa
 * existir no DB para valer. Texto idêntico ao bloco "25." hardcoded em
 * server/ai/promptsLoader.js. É o reforço (LLM) do gate determinístico em
 * server/inscricaoMatriculaConfirmFlow.js.
 *
 * Idempotente: se a regra 25 já existir, não faz nada.
 * Reversível: DELETE em agent_rules?id=eq.25 (e agent_rule_versions?rule_id=eq.25).
 *
 * Uso:
 *   node --env-file=.env scripts/add-rule-confirmacao-matricula.mjs --dry-run
 *   node --env-file=.env scripts/add-rule-confirmacao-matricula.mjs
 */

const DRY_RUN = process.argv.includes('--dry-run')
const env = { ...process.env }
const URL = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const KEY = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''

const RULE_ID = 25
const TITLE = 'Confirmação antes da matrícula — resumo + autorização'
const BODY = `25. CONFIRMAÇÃO ANTES DA MATRÍCULA — RESUMO + AUTORIZAÇÃO (antes de enviar o formulário)

    Quando o lead confirmar que quer SE MATRICULAR num curso específico, NÃO envie o formulário ainda (não chame enviar_form_sumar_inscricao neste turno). Primeiro busque valor e duração do curso (buscar_precos / buscar_conhecimento) e envie um RESUMO para o lead AUTORIZAR, exatamente neste formato:

    "Então, ficou assim:

    - Você irá ingressar no curso de "<curso>" com duração de <duração>
    - Mensalidades: <valor da mensalidade com desconto>
    - A taxa de matrícula é a primeira mensalidade, no valor de <valor da mensalidade com desconto>.

    Você autoriza a conclusão da matrícula?"

    REGRAS:
    - Taxa de matrícula = a primeira mensalidade (mesmo valor da mensalidade; não invente outro valor).
    - Duração: graduação em semestres; pós-graduação conforme a base (se a base não tiver a duração da pós, omita a parte "com duração de …").
    - Use SOMENTE valores do CONTEXT/base — não invente preço nem duração.
    - SÓ chame enviar_form_sumar_inscricao DEPOIS que o lead autorizar ("sim", "autorizo", "pode concluir").
    - Se o lead tiver dúvida ou recusar, NÃO envie o formulário: responda a dúvida e siga o atendimento normal. Encaminhe consultor (distribuir_humano) apenas se for realmente necessário.`

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function main() {
  if (!URL || !KEY) throw new Error('SUPABASE_URL/KEY ausentes')

  const chk = await fetch(`${URL}/rest/v1/agent_rules?id=eq.${RULE_ID}&select=id,version,title`, { headers: H })
  const existing = await chk.json()
  if (Array.isArray(existing) && existing.length > 0) {
    console.log(`Regra ${RULE_ID} JÁ EXISTE (v${existing[0].version} — "${existing[0].title}"). Nada a fazer.`)
    return
  }

  console.log(`── agent_rules id=${RULE_ID} ──`)
  console.log(`title: ${TITLE}`)
  console.log(BODY)
  if (DRY_RUN) {
    console.log('\n[dry-run] a regra seria inserida em agent_rules + agent_rule_versions.')
    return
  }

  const r1 = await fetch(`${URL}/rest/v1/agent_rules`, {
    method: 'POST',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify([{ id: RULE_ID, version: 1, title: TITLE, body: BODY, updated_by: 'seed' }]),
  })
  const t1 = await r1.text()
  console.log(`\nINSERT agent_rules status=${r1.status} ok=${r1.ok}`)
  if (!r1.ok) {
    console.log('  erro:', t1.slice(0, 400))
    process.exit(1)
  }

  const r2 = await fetch(`${URL}/rest/v1/agent_rule_versions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify([{ rule_id: RULE_ID, version: 1, body: BODY, source: 'seed', applied_by: 'seed' }]),
  })
  console.log(`INSERT agent_rule_versions status=${r2.status} ok=${r2.ok}`)
  if (!r2.ok) console.log('  aviso (histórico):', (await r2.text()).slice(0, 300))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
