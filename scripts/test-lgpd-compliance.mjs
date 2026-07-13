/**
 * Unit: guard LGPD — falso positivo "Banco de Dados" (curso) vs dado bancário real.
 * npm run test:lgpd-compliance
 */
import { replyLeaksSensitiveCandidateData } from '../libShared/lgpdCompliance.js'

const stats = { passed: 0, failed: 0, total: 0 }

function expect(label, ok) {
  stats.total += 1
  if (ok) {
    stats.passed += 1
    console.log(`  ok ${label}`)
  } else {
    stats.failed += 1
    console.error(`  FAIL ${label}`)
  }
}

const cursoReply =
  'O curso de graduação de Banco de Dados da Faculdade Sumaré é um tecnólogo com duração de 5 semestres, ' +
  'oferecido na modalidade EAD. A mensalidade com desconto é R$ 87,00, e o valor cheio é R$ 290,00.'

expect(
  'curso Banco de Dados + mensalidade não bloqueia',
  replyLeaksSensitiveCandidateData(cursoReply, {
    userMessage: 'valor da mensalidade da graduação de Banco de Dados',
  }).leak === false,
)

expect(
  'pix do candidato bloqueia',
  replyLeaksSensitiveCandidateData('O pix do candidato é abc123def456', { userMessage: '' }).code === 'lgpd_financial_leak',
)

expect(
  'conta bancária do aluno bloqueia',
  replyLeaksSensitiveCandidateData('A conta bancária do aluno termina em 1234', { userMessage: '' }).leak === true,
)

const pubReply =
  'O curso de Publicidade e Propaganda prepara você para atuar no dinâmico mercado da comunicação, ' +
  'desenvolvendo habilidades em criação de campanhas e agências de publicidade.'

expect(
  'Publicidade e Propaganda + agências de publicidade não bloqueia',
  replyLeaksSensitiveCandidateData(pubReply, {
    userMessage: 'Mais informações sobre publicidade e propaganda',
  }).leak === false,
)

const { validateReplyBeforeSend } = await import('../server/replyGuard.js')
const guardVerdict = validateReplyBeforeSend({
  reply: pubReply,
  userMessage: 'Mais informações sobre publicidade e propaganda',
})
expect('guard validateReply LGPD não bloqueia curso Publicidade', guardVerdict.violation === false)

console.log(`\n${stats.passed}/${stats.total} passed`)
if (stats.failed > 0) process.exit(1)
