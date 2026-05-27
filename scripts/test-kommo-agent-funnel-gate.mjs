/**
 * Smoke: trinco fixo pipeline 13756724 + status 106140284.
 * npm run test:funnel-gate
 */

import {
  AGENT_FUNNEL_PIPELINE_ID,
  AGENT_FUNNEL_STATUS_ID,
  leadMatchesAgentFunnel,
  resolveAgentFunnelFromEnv,
} from '../server/kommoAgentFunnelGate.js'

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

expect('pipeline id fixo', AGENT_FUNNEL_PIPELINE_ID === 13756724)
expect('status id fixo', AGENT_FUNNEL_STATUS_ID === 106140284)

const resolved = resolveAgentFunnelFromEnv({
  KOMMO_AGENT_PIPELINE_ID: '13080160',
  KOMMO_AGENT_STATUS_ID: '100859840',
  KOMMO_AGENT_STATUS_IDS: '106377088,100859840',
})
expect('env errado ignorado (pipeline)', resolved.pipelineId === 13756724)
expect('env errado ignorado (status)', resolved.statusIds.length === 1 && resolved.statusIds[0] === 106140284)

expect(
  'lead na fila',
  leadMatchesAgentFunnel({ pipeline_id: 13756724, status_id: 106140284 }),
)
expect(
  'lead comercial em atendimento bloqueado',
  !leadMatchesAgentFunnel({ pipeline_id: 13080160, status_id: 100859840 }),
)
expect(
  'lead agente aguardando resposta bloqueado',
  !leadMatchesAgentFunnel({ pipeline_id: 13756724, status_id: 106377088 }),
)

console.log(`\n${stats.passed}/${stats.total} passed`)
if (stats.failed > 0) process.exit(1)
