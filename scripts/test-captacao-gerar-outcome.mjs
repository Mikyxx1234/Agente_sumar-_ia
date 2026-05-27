import {
  parseGerarCandidatoPayload,
  classifyGerarCandidatoOutcome,
  coursesMatch,
} from '../libShared/captacaoGerarOutcome.js'

let failed = 0
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg)
    failed += 1
  } else {
    console.log('PASS', msg)
  }
}

const pagamentoGsp = parseGerarCandidatoPayload({
  pagina: 'Pagamento',
  candidato: '2026700000005585',
  curso: 'SGPV_EAD',
  nomeCurso: 'Superior de Tecnologia em Gestão de Segurança Privada',
})
const outSame = classifyGerarCandidatoOutcome(pagamentoGsp, {
  nome: 'Gestão de Segurança Privada',
  codigo: 'SGPV_EAD',
})
assert(outSame.kind === 'same_course_in_progress', 'same course payment')

const outDiff = classifyGerarCandidatoOutcome(
  parseGerarCandidatoPayload({
    pagina: 'Contrato',
    candidato: '1',
    curso: 'ADM_EAD',
    nomeCurso: 'Administração',
  }),
  { nome: 'Gestão de Segurança Privada', codigo: 'SGPV_EAD' },
)
assert(outDiff.kind === 'different_course_new', 'different course contrato')

assert(
  coursesMatch(
    { nome: 'Gestão de Segurança Privada', codigo: 'SGPV_EAD' },
    { cursoCodigo: 'SGPV_EAD', nomeCurso: 'Superior de Tecnologia em Gestão de Segurança Privada' },
  ),
  'fuzzy course name match',
)

console.log(failed ? `\n${failed} failed` : '\nAll passed')
process.exit(failed ? 1 : 0)
