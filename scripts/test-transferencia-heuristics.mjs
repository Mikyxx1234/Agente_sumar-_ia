/**
 * Heurísticas de transferência externa — cenário Lidi (#24016559).
 * node scripts/test-transferencia-heuristics.mjs
 */
import {
  extractTransferenciaContext,
  messageRestatesSameCourseAsDestino,
  parseSemestreFromUserMessage,
  isValidTransferenciaCursoLabel,
} from '../server/inscricaoTransferenciaFlow.js'
import { resolveTransferenciaCursoCodigo } from '../server/sumareCaptacaoClient.js'

const lidiHistory = [
  { role: 'user', content: 'Gostaria me matricular no curso de pedagogia como faço? Boa noite' },
  {
    role: 'assistant',
    content:
      'Perfeito! Então, ficou assim:\n- Você irá ingressar no curso de "Pedagogia" com duração de 8 semestres',
  },
  {
    role: 'user',
    content:
      'E q eu já comecei a pedagogia em outra faculdade. E esqueci de avisá-lo Tranquei no quarto semestre',
  },
  {
    role: 'assistant',
    content:
      'Ótimo! Para dar início ao processo de aproveitamento e transferência do seu curso de Pedagogia, preciso que você me informe o curso e o último semestre.',
  },
  { role: 'user', content: 'Como falei parei no quarto semestre' },
  {
    role: 'assistant',
    content:
      'Obrigado por informar que você parou no quarto semestre. Preciso que me confirme o nome exato do curso que você cursava na outra faculdade.',
  },
  { role: 'user', content: 'Só a pedagogia mesmo' },
]

const ctx = extractTransferenciaContext(lidiHistory)
console.log('context', ctx)

const checks = [
  ['destino Pedagogia', ctx?.destino === 'Pedagogia'],
  ['origem Pedagogia', ctx?.origem === 'Pedagogia'],
  ['semestre 4', ctx?.semestre === '4'],
  ['origem válida', isValidTransferenciaCursoLabel(ctx?.origem)],
  ['não parseia matricula inicial', ctx?.origem !== 'de pedagogia como faço? Boa noite'],
  ['same course restate', messageRestatesSameCourseAsDestino('Só a pedagogia mesmo', 'Pedagogia')],
  ['semestre quarto', parseSemestreFromUserMessage('Como falei parei no quarto semestre') === '4'],
]

let fail = 0
for (const [name, ok] of checks) {
  console.log(ok ? 'OK' : 'FAIL', name)
  if (!ok) fail++
}

if (process.env.SUMARE_CAPTACAO_TOKEN) {
  const ped = await resolveTransferenciaCursoCodigo(process.env, 'Pedagogia')
  console.log('resolve Pedagogia', ped)
  if (!ped?.codigo) {
    console.log('FAIL resolve Pedagogia')
    fail++
  } else {
    console.log('OK resolve Pedagogia', ped.codigo)
  }
}

process.exit(fail > 0 ? 1 : 0)
