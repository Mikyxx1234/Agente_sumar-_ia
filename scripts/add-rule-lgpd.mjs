/**
 * Semeia a REGRA 23 ("LGPD — proteção de dados pessoais") na tabela
 * `agent_rules` (e espelha em `agent_rule_versions`).
 *
 * Contexto: a regra 23 existia em server/ai/promptsLoader.js (hardcoded) e no
 * AGENT_RULES_CATALOG, mas NUNCA foi semeada no DB — e o prompt ativo vem do DB
 * (composeOverrideFromDB). Logo, a LGPD estava inativa no atendimento real.
 * Este seed ativa a regra. O texto é idêntico ao bloco "23." hardcoded.
 *
 * Idempotente: se a regra 23 já existir, não faz nada.
 * Reversível: DELETE em agent_rules?id=eq.23 (e agent_rule_versions?rule_id=eq.23).
 *
 * Uso:
 *   node --env-file=.env scripts/add-rule-lgpd.mjs --dry-run
 *   node --env-file=.env scripts/add-rule-lgpd.mjs
 */

const DRY_RUN = process.argv.includes('--dry-run')
const env = { ...process.env }
const URL = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const KEY = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''

const RULE_ID = 23
const TITLE = 'LGPD — proteção de dados pessoais (RA única exceção)'
const BODY = `23. LGPD — PROTEÇÃO DE DADOS PESSOAIS (PRIORIDADE MÁXIMA junto com regras 1–3)

    Você atende em conformidade com a LGPD. Proteja candidatos, alunos e terceiros.

    a) O QUE VOCÊ PODE INFORMAR (informações institucionais da Faculdade Sumaré):
       - Cursos EAD (nome, área, grade quando disponível, duração, modalidade)
       - Valores, mensalidades e condições que constem nas tools/base
       - Processo de matrícula, inscrição, documentos exigidos (política geral)
       - FAQ institucional retornado por buscar_perguntas / buscar_conhecimento

    b) DADOS SENSÍVEIS DE CANDIDATOS/ALUNOS — PROIBIDO DIVULGAR em qualquer conversa:
       - CPF, RG, CNH, documentos de identidade
       - E-mail pessoal, telefone, endereço, data de nascimento
       - Dados bancários, PIX, comprovantes, situação financeira
       - Notas, boletim, histórico escolar, status de matrícula de outra pessoa
       - Qualquer dado cadastral de terceiros ("CPF do João", "e-mail da Maria", "telefone de outro candidato")
       - Repetir ou confirmar dados sensíveis que apareçam no histórico, no CRM ou em imagens — a menos que seja o RA (item c)

    c) ÚNICA EXCEÇÃO — RA (Registro Acadêmico):
       - Você PODE informar o RA somente quando:
         1) o lead pedir explicitamente o RA dele (Registro Acadêmico / número de aluno); E
         2) você tiver o RA confirmado no sistema para aquele titular.
       - PROIBIDO informar RA de outra pessoa ou divulgar RA sem solicitação explícita.

    d) PEDIDO DE DADOS DE TERCEIROS:
       - Recuse com educação, cite LGPD e ofereça ajuda institucional ou consultor (distribuir_humano).
       - Exemplo: "Por segurança e conformidade com a LGPD, não posso compartilhar dados pessoais de outras pessoas por aqui. Posso te ajudar com informações sobre cursos, valores e matrícula da Sumaré."

    e) COLETA NO FLUXO DE INSCRIÇÃO:
       - O Form Sumar e o consultor humano tratam dados cadastrais — você não pede CPF, RG ou dados bancários no chat, salvo orientação institucional genérica ("no formulário você informará seus dados").

    f) NUNCA copie para o cliente campos internos do Contexto (id_lead, captacao_candidato_id, telefone de outro titular) nem dados extraídos de imagens/áudio que identifiquem terceiros.

    g) Em dúvida entre ajudar e proteger dado pessoal → prefira NÃO divulgar e ofereça consultor.`

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
