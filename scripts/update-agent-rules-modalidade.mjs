/**
 * Atualiza no DB (agent_rules) as regras que afirmavam "somente EAD" para
 * refletir EAD + Semipresencial. Versiona via applyRulePatch.
 *
 * Uso:
 *   node --env-file=.env scripts/update-agent-rules-modalidade.mjs --dry-run
 *   node --env-file=.env scripts/update-agent-rules-modalidade.mjs
 */
import { listActiveRules, applyRulePatch } from '../server/feedbackIA/rulesStore.js'

const DRY = process.argv.includes('--dry-run')
const env = process.env

const RULE6_NEW = `6. MODALIDADE — EAD OU SEMIPRESENCIAL (conforme o CONTEXT de cada curso).
   A Faculdade Sumaré oferece cursos em duas modalidades: EAD e Semipresencial. A modalidade de cada curso é definida pelo CONTEXT da tool (campo "modalidade") — informe SEMPRE a modalidade que vier no resultado para aquele curso, sem inventar.
   - Curso EAD: 100% a distância (provas/atividades práticas podem ser agendadas online ou em polo, conforme o curso).
   - Curso Semipresencial: combina disciplinas EAD com encontros/aulas presenciais agendados.
   NÃO existe oferta 100% presencial — se o lead perguntar por presencial puro/"aulas no campus", explique que a Sumaré trabalha com EAD e Semipresencial e diga em qual delas o curso de interesse está disponível.
   NÃO ofereça buscar polo, distância, endereço de unidade nem tempo de deslocamento — isso não se aplica ao atendimento.
   Se o CONTEXT não trouxer a modalidade de um curso, NÃO chute: trate como não especificado e, se preciso, use distribuir_humano.`

// id -> função que recebe o body atual e devolve o novo (ou null se nada mudou)
const TRANSFORMS = {
  2: (b) =>
    b.replace(
      'a Faculdade Sumaré atende somente na modalidade EAD (ensino a distância).',
      'a Faculdade Sumaré atende a distância; os cursos são EAD ou Semipresencial conforme a base (a modalidade real de cada curso vem do CONTEXT).',
    ),
  6: () => RULE6_NEW,
  15: (b) =>
    b
      .replace(
        'c) MODALIDADE NA SUMARÉ: trate sempre como EAD para comunicação com o lead. Se o CONTEXT trouxer "Semi-Presencial" ou "Presencial" em campo legado do catálogo, informe o preço/informação como referência EAD e deixe claro que a matrícula na Sumaré é a distância (não há oferta presencial/semi-presencial nas unidades).',
        'c) MODALIDADE NA SUMARÉ: informe a modalidade que vier no CONTEXT daquele curso ("modalidade: EAD" ou "modalidade: Semipresencial"). Cada curso tem UMA modalidade na base — não troque nem invente. NÃO existe oferta 100% presencial; se o CONTEXT trouxer "Presencial" isolado, trate como Semipresencial.',
      )
      .replace(
        'cite o valor EAD aplicável (um único valor por curso, salvo instrução explícita no CONTEXT). Não compare presencial vs EAD.',
        'cite o valor da modalidade do curso no CONTEXT (cada curso tem uma única modalidade/valor, salvo instrução explícita no CONTEXT).',
      ),
  18: (b) =>
    b.replace(
      'Perguntas sobre polo/unidade presencial: explique que o modelo é EAD; se precisar de detalhe institucional, use distribuir_humano.',
      'Perguntas sobre polo/unidade presencial: explique que o atendimento é a distância (cursos EAD e Semipresencial, com encontros agendados nos semipresenciais); se precisar de detalhe institucional, use distribuir_humano.',
    ),
}

async function main() {
  const r = await listActiveRules(env)
  if (!r.ok) throw new Error(`listActiveRules: ${r.error || r.code}`)
  const byId = new Map(r.data.map((x) => [x.id, x]))

  for (const idStr of Object.keys(TRANSFORMS)) {
    const id = Number(idStr)
    const rule = byId.get(id)
    if (!rule) { console.warn(`! regra ${id} não encontrada no DB`); continue }
    const newBody = TRANSFORMS[id](rule.body)
    if (newBody === rule.body) {
      console.warn(`! regra ${id}: substituição NÃO casou (texto inalterado) — verifique o original`)
      continue
    }
    console.log(`\n=== regra ${id} (${rule.title}) v${rule.version} ===`)
    console.log('NEW:\n' + newBody.slice(0, 600))
    if (DRY) continue
    const res = await applyRulePatch(env, id, { body: newBody, applied_by: 'migracao_modalidade', source: 'patch_approved' })
    if (!res.ok) console.error(`  ERRO regra ${id}: ${res.error || res.code}`)
    else console.log(`  OK regra ${id} → v${res.newVersion}`)
  }
  console.log(DRY ? '\n[dry-run] nada gravado.' : '\nConcluído.')
}

main().catch((e) => { console.error(e); process.exit(1) })
