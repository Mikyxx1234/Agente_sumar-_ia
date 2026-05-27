/**
 * Diagnóstico rápido das heurísticas do fluxo de inscrição contra mensagens reais.
 * Uso: node --env-file=.env scripts/diag-lead.mjs
 */
import { matchPoloFromUserMessage, assistantAskedPoloPreFormChoice } from '../libShared/sumarePoloCatalog.js'
import {
  messageConfirmsProceedToInscricaoForm,
  isShortEnrollmentConfirmation,
  messageLooksLikeFormSumarResponse,
  messageIsFlowResponsesReceived,
  messageSignalsFormSubmissionAck,
} from '../libShared/inscricaoFormHeuristics.js'

console.log('=== matchPoloFromUserMessage ===')
const samples = ['5', ' 5 ', '5.', '5️⃣', 'opção 5', 'Pinheiros', 'pinheiros', 'barra funda', '4', '3', '2', '1']
for (const s of samples) {
  const p = matchPoloFromUserMessage(s)
  console.log(`  "${s}" =>`, p ? `${p.id} (${p.nome})` : 'null')
}

const lastAssist = `Perfeito! Para seguir com sua inscrição na Faculdade Sumaré, primeiro preciso saber em qual *polo* você prefere se cadastrar. Todos os cursos são EAD; o polo é o ponto de apoio presencial.

Por este canal oferecemos *somente* estes polos:

1. *São Miguel* — Rua Bernardo Bellotto, 8
2. *Barra Funda* — Av. Marquês de São Vicente, 405 - Loja 5
3. *Tatuapé* — Rua Martins Soares, 135
4. *Santana* — Rua Dr. Olavo Egídio, 14
5. *Pinheiros* — Rua Amélia de Noronha, 130

Responda com o *número* (1 a 5) ou o *nome do polo*`

console.log('\n=== assistantAskedPoloPreFormChoice ===')
console.log('  lastAssist canonical =>', assistantAskedPoloPreFormChoice(lastAssist))

console.log('\n=== messageConfirmsProceedToInscricaoForm ===')
const inscMsgs = ['matricula', 'matrícula', 'inscricao', 'inscrição', 'quero me inscrever', 'quero matricula', 'fazer matricula', 'iniciar inscrição']
for (const m of inscMsgs) {
  const noHist = messageConfirmsProceedToInscricaoForm(m, [])
  const withHist = messageConfirmsProceedToInscricaoForm(m, [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: 'O curso de Nutrição da Faculdade Sumaré...' },
  ])
  console.log(`  "${m}" => sem_hist=${noHist} com_hist=${withHist}`)
}

console.log('\n=== isShortEnrollmentConfirmation ===')
for (const m of ['5', 'sim', 'ok', 'pronto']) {
  console.log(`  "${m}" =>`, isShortEnrollmentConfirmation(m))
}

console.log('\n=== messageSignalsFormSubmissionAck ===')
for (const m of ['pronto', 'preenchi', 'Flow responses received', 'Respostas recebidas no Flow', '5']) {
  console.log(`  "${m}" =>`, messageSignalsFormSubmissionAck(m))
}
