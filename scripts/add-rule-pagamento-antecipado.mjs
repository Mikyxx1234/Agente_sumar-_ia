/**
 * Insere a REGRA 24 ("Desconto por pagamento antecipado — informar 1× junto
 * com o valor") na tabela `agent_rules` (e espelha em `agent_rule_versions`).
 *
 * O prompt ativo do agente vem do DB (composeOverrideFromDB), então a regra
 * precisa existir no DB para valer. O texto abaixo é idêntico ao bloco "24."
 * hardcoded em server/ai/promptsLoader.js (fallback).
 *
 * Idempotente: se a regra 24 já existir, não faz nada.
 * Reversível: DELETE em agent_rules?id=eq.24 (e agent_rule_versions?rule_id=eq.24).
 *
 * Uso:
 *   node --env-file=.env scripts/add-rule-pagamento-antecipado.mjs --dry-run
 *   node --env-file=.env scripts/add-rule-pagamento-antecipado.mjs
 */

const DRY_RUN = process.argv.includes('--dry-run')
const env = { ...process.env }
const URL = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const KEY = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''

const RULE_ID = 24
const TITLE = 'Desconto pagamento antecipado — informar 1× com o valor'
const BODY = `24. DESCONTO POR PAGAMENTO ANTECIPADO — INFORMAR 1× JUNTO COM O VALOR

    A base (grad_info / pos_info) tem o "Plano de Benefício para Pagamento Antecipado Facultativo": pagando antes, o candidato tem desconto na mensalidade — 70% no 1º dia do mês, 50% do 2º ao 5º dia, 20% do 6º ao 10º dia; após o dia 10 NÃO há desconto. Vale para graduação e pós.

    QUANDO ENVIAR:
    a) Na PRIMEIRA vez que você informar o valor/mensalidade de um curso na conversa, envie também — de forma breve, logo após o valor — esse benefício de pagamento antecipado.
    b) Ou sempre que o candidato perguntar especificamente sobre isso (ex.: "quais dias posso pagar?", "tem desconto se pagar antes?", "como funciona o desconto?").

    ENVIAR APENAS UMA VEZ:
    - Depois de já ter apresentado esse benefício uma vez na conversa, NÃO repita nas próximas vezes que citar preço. Confira o histórico (regra 5) antes de enviar.
    - EXCEÇÃO: se o candidato perguntar de novo / diretamente sobre o desconto antecipado, você PODE informar novamente, mesmo que já tenha citado.

    COMO: traga os números do CONTEXT/base (buscar_conhecimento retorna "pagamento antecipado"); NÃO invente percentuais ou dias diferentes. Apresente junto do valor, sem poluir a resposta — pode resumir (ex.: "pagando até o dia 10 você tem desconto na mensalidade: 70% no 1º dia, 50% do 2º ao 5º e 20% do 6º ao 10º").`

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
