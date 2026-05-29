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

assert.equal(messageRequestsThirdPartySensitiveData('qual o CPF do candidato João?'), true)
assert.equal(messageRequestsThirdPartySensitiveData('quanto custa administração?'), false)
assert.equal(messageRequestsOwnRa('qual é o meu RA?'), true)
assert.equal(messageRequestsOwnRa('me passa o CPF de outra pessoa'), false)

const cpfLeak = replyLeaksSensitiveCandidateData('O CPF dele é 123.456.789-00')
assert.equal(cpfLeak.leak, true)
assert.equal(cpfLeak.code, 'lgpd_cpf_leak')

const raOk = replyLeaksSensitiveCandidateData('Seu RA é 2024012345', {
  userMessage: 'qual meu RA?',
})
assert.equal(raOk.leak, false)

const raBad = replyLeaksSensitiveCandidateData('O RA dela é 2024012345', {
  userMessage: 'oi',
})
assert.equal(raBad.leak, true)

const guard = validateReplyLgpd({
  reply: 'O e-mail dela é maria@gmail.com',
  userMessage: 'me passa o email da Maria',
})
assert.equal(guard.violation, true)
assert.equal(guard.code, 'lgpd_email_leak')

console.log('test-lgpd-guard: OK')
