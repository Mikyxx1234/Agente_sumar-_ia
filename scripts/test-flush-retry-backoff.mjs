/**
 * Unit: backoff de retry de envio (flushRetryBackoff) + echo da nota de handover.
 * npm run test:flush-retry-backoff
 *
 * Incidente que motivou (11/06/2026): token Meta expirado (erro 190) → envio
 * falhava → repush → novo flush a cada tick → loop infinito de execuções LLM
 * (212 leads, 1000+ execuções queimadas sem nenhuma mensagem entregue).
 */

import {
  recordSendFailureBackoff,
  shouldHoldForSendRetryBackoff,
  clearSendRetryBackoff,
  shouldEscalateSendFailure,
  getSendRetryBackoffSnapshot,
  resetSendRetryBackoffForTests,
} from '../server/flushRetryBackoff.js'
import { isKommoSystemOrIntegrationNote } from '../libShared/inboundMessageSanitize.js'

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

const env = {}
const sid = '5511970789084@s.whatsapp.net'
const items = ['Td bem', 'Quero saber a respeito da nota do trabalho']

// Sem falha registrada → não segura.
resetSendRetryBackoffForTests()
expect('sem falha → não segura', shouldHoldForSendRetryBackoff(env, sid, items).hold === false)

// 1ª falha → segura o MESMO conteúdo por 2min (regra da operação).
const f1 = recordSendFailureBackoff(env, sid, items)
expect('1ª falha → failCount=1', f1.failCount === 1)
expect('1ª falha → retry em 2min', f1.nextRetryInMs === 120_000)
const h1 = shouldHoldForSendRetryBackoff(env, sid, items)
expect('mesmo conteúdo no backoff → hold', h1.hold === true && h1.failCount === 1)
expect('1ª falha → ainda NÃO escala', shouldEscalateSendFailure(env, f1.failCount) === false)

// Conteúdo DIFERENTE (inbound novo) → NÃO segura e limpa o estado antigo.
const h2 = shouldHoldForSendRetryBackoff(env, sid, [...items, 'mensagem nova do cliente'])
expect('inbound novo → não segura', h2.hold === false)
expect('inbound novo → estado limpo', getSendRetryBackoffSnapshot().length === 0)

// Backoff exponencial: 2min, 4min, 8min… com teto.
resetSendRetryBackoffForTests()
recordSendFailureBackoff(env, sid, items)
const f2 = recordSendFailureBackoff(env, sid, items)
const f3 = recordSendFailureBackoff(env, sid, items)
expect('2ª falha → 4min', f2.failCount === 2 && f2.nextRetryInMs === 240_000)
expect('3ª falha → 8min', f3.failCount === 3 && f3.nextRetryInMs === 480_000)

// 2ª falha consecutiva → escala ao humano (nota + mover p/ 13756724/106377088).
expect('2ª falha → escala', shouldEscalateSendFailure(env, f2.failCount) === true)
expect('3ª falha → também escala (se ainda no funil)', shouldEscalateSendFailure(env, f3.failCount) === true)
expect(
  'limiar configurável (3)',
  shouldEscalateSendFailure({ AGENT_SEND_FAIL_ESCALATE_AFTER: '3' }, 2) === false &&
    shouldEscalateSendFailure({ AGENT_SEND_FAIL_ESCALATE_AFTER: '3' }, 3) === true,
)

// Teto configurável.
resetSendRetryBackoffForTests()
const envCap = { AGENT_SEND_RETRY_BASE_SEC: '60', AGENT_SEND_RETRY_MAX_SEC: '300' }
let last = null
for (let i = 0; i < 10; i++) last = recordSendFailureBackoff(envCap, sid, items)
expect('teto respeitado (300s)', last.nextRetryInMs === 300_000)

// Envio confirmado limpa.
clearSendRetryBackoff(sid)
expect('envio ok → não segura mais', shouldHoldForSendRetryBackoff(envCap, sid, items).hold === false)

// Sessões independentes.
resetSendRetryBackoffForTests()
recordSendFailureBackoff(env, sid, items)
expect(
  'outra sessão não é afetada',
  shouldHoldForSendRetryBackoff(env, 'outro@s.whatsapp.net', items).hold === false,
)

// ── Echo da nota de handover (re-injetada como fala do lead no incidente) ──
expect(
  'nota handover é nota de sistema',
  isKommoSystemOrIntegrationNote(
    'Encaminhamento automático: lead pediu atendimento humano via WhatsApp (agente IA).',
  ),
)
expect(
  'variante com curso é nota de sistema',
  isKommoSystemOrIntegrationNote(
    'Encaminhamento automático: lead pediu atendimento humano via WhatsApp (agente IA).\nCurso mencionado: Direito',
  ),
)
expect(
  'fala real do lead pedindo humano NÃO é nota de sistema',
  !isKommoSystemOrIntegrationNote('quero falar com um atendente humano por favor'),
)
expect(
  'fala do lead sobre encaminhamento NÃO é nota de sistema',
  !isKommoSystemOrIntegrationNote('vcs vao me encaminhar para alguem?'),
)
expect(
  'nota de escalação por falha de envio é nota de sistema (não re-injeta)',
  isKommoSystemOrIntegrationNote(
    'Encaminhamento automático: IA não conseguiu responder o lead após 2 tentativas. ' +
      'Erro: WhatsApp falhou: {"error":{"message":"Authentication Error","code":190}} (agente IA)',
  ),
)

console.log(`\n${stats.passed}/${stats.total} passed`)
if (stats.failed > 0) process.exit(1)
