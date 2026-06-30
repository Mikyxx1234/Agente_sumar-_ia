/**
 * Smoke: heurísticas Api Sumaré (origem + CPF).
 * node scripts/test-api-sumare-origem-heuristics.mjs
 */

import {
  isApiSumareOrigemValue,
  isApiSumareOrigemSnapshot,
  extractCpfFromMessage,
  API_SUMARE_SALESBOT_INSCRICAO_ID,
  API_SUMARE_SALESBOT_PAGAMENTO_ID,
} from '../libShared/apiSumareOrigemHeuristics.js'

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

expect('Api Sumaré acento', isApiSumareOrigemValue('Api Sumaré'))
expect('Api Sumare sem acento', isApiSumareOrigemValue('Api Sumare'))
expect('Site não é Api', !isApiSumareOrigemValue('Site'))
expect('snapshot origem', isApiSumareOrigemSnapshot({ origem: 'Api Sumaré' }))
expect('cpf formatado', extractCpfFromMessage('meu cpf é 423.901.758-05') === '42390175805')
expect('salesbot inscrição', API_SUMARE_SALESBOT_INSCRICAO_ID === 49977)
expect('salesbot pagamento', API_SUMARE_SALESBOT_PAGAMENTO_ID === 49979)

console.log(`\n${stats.passed}/${stats.total} passed`)
if (stats.failed > 0) process.exit(1)
