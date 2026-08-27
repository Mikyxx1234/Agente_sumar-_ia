/**
 * Testes rápidos do guard LGPD (libShared/lgpdCompliance.js + replyGuard).
 */
import assert from 'node:assert/strict'
import {
  messageRequestsThirdPartySensitiveData,
  messageRequestsOwnRa,
  replyLeaksSensitiveCandidateData,
} from '../libShared/lgpdCompliance.js'
import { validateReplyLgpd } from '../server/replyGuard.js'
import { formatPoloListaNumerada } from '../libShared/sumarePoloCatalog.js'
import {
  messageAsksPaymentInfo,
  messageAsksPoloAttendimentoList,
  messageAsksTaxaMatriculaInstitucional,
} from '../libShared/inboundMessageSanitize.js'

assert.equal(messageRequestsThirdPartySensitiveData('qual o CPF do candidato João?'), true)
assert.equal(messageRequestsThirdPartySensitiveData('quanto custa administração?'), false)
assert.equal(messageRequestsThirdPartySensitiveData('Tem matrícula?'), false)
assert.equal(messageRequestsOwnRa('qual é o meu RA?'), true)
assert.equal(messageRequestsOwnRa('me passa o CPF de outra pessoa'), false)

const vivianMsg =
  'Certo Então a 1 é 97 ou todas se eu pagar no prazo é 97 Só pra ver se eu entendi Tem matrícula? E só tem EAD certo? Se eu precisar ir algum polo tem algum próximo de casa?'
assert.equal(messageAsksPaymentInfo(vivianMsg), true)
assert.equal(messageAsksTaxaMatriculaInstitucional(vivianMsg), true)
assert.equal(messageAsksPoloAttendimentoList(vivianMsg), true)

const cpfLeak = replyLeaksSensitiveCandidateData('O CPF dele é 123.456.789-00')
assert.equal(cpfLeak.leak, true)
assert.equal(cpfLeak.code, 'lgpd_cpf_leak')

const poloListReply =
  'Por este número de contato atendemos os seguintes polos:\n' + formatPoloListaNumerada()
const poloOk = replyLeaksSensitiveCandidateData(poloListReply, {
  userMessage: 'tem algum polo próximo de casa?',
})
assert.equal(poloOk.leak, false)

const guardPolo = validateReplyLgpd({
  reply: poloListReply,
  userMessage: 'tem algum polo próximo de casa?',
})
assert.equal(guardPolo.violation, false)

const raOk = replyLeaksSensitiveCandidateData('Seu RA é 2024012345', {
  userMessage: 'qual meu RA?',
})
assert.equal(raOk.leak, false)

const raBad = replyLeaksSensitiveCandidateData('O RA dela é 2024012345', {
  userMessage: 'oi',
})
assert.equal(raBad.leak, true)
assert.equal(raBad.code, 'lgpd_ra_third_party')

const guard = validateReplyLgpd({
  reply: 'O e-mail dela é maria@gmail.com',
  userMessage: 'me passa o email da Maria',
})
assert.equal(guard.violation, true)
assert.equal(guard.code, 'lgpd_email_leak')

// Formas de pagamento da mensalidade (boleto/PIX/cartão) — não é vazamento LGPD (Thiago #24137069).
assert.equal(messageAsksPaymentInfo('formas de pagamento de mensalidades'), true)
assert.equal(messageAsksPaymentInfo('posso pagar o boleto no cartão'), true)
assert.equal(messageAsksPaymentInfo('como pago o link da matrícula'), false)

const formasPagamentoReply =
  'O pagamento das mensalidades pode ser efetuado de três formas: boleto bancário, PIX e cartão de crédito. ' +
  'É possível escolher e alterar a forma de pagamento no Portal do Aluno sempre que a mensalidade estiver disponível.'
const formasPagamentoOk = replyLeaksSensitiveCandidateData(formasPagamentoReply, {
  userMessage: 'quais são as formas de pagamento da mensalidade?',
})
assert.equal(formasPagamentoOk.leak, false)

const pixEmailLeak = replyLeaksSensitiveCandidateData('PIX do aluno: email@gmail.com')
assert.equal(pixEmailLeak.leak, true)

const contaBancariaLeak = replyLeaksSensitiveCandidateData('A conta bancária dele: agência 001 conta 12345-6')
assert.equal(contaBancariaLeak.leak, true)
assert.equal(contaBancariaLeak.code, 'lgpd_financial_leak')

console.log('test-lgpd-guard: OK')
