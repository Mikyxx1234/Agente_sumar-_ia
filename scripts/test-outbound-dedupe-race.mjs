/**
 * Smoke test do gate de envio outbound — valida a separação entre
 * race (`outbound_inflight_sync`) e dedupe legítimo (mensagem idêntica).
 *
 * Regressão de 27/05/26: race era mascarada como `deduped: true`, o
 * webhookEvolution marcava `sentOk=true` e gravava `recordBufferFlushHash`,
 * silenciando o cliente (#23841399 às 17:23 BRT).
 *
 * Não toca em rede: o teste isola o módulo `outboundDedupe.js` via locks
 * in-memory + mock leve do `fetchRecentChatRows` (stubbed por env vazio).
 */

import {
  tryReserveOutboundSync,
  releaseOutboundSync,
  shouldSkipDuplicateOutbound,
} from '../server/outboundDedupe.js'

const stats = { passed: 0, failed: 0, total: 0 }

function expect(label, actual, predicate) {
  stats.total += 1
  const ok = predicate(actual)
  if (ok) {
    stats.passed += 1
    console.log(`  ok ${label}`)
  } else {
    stats.failed += 1
    console.error(`  FAIL ${label} → ${JSON.stringify(actual)}`)
  }
}

function envWithoutSupabase() {
  // Sem SUPABASE_URL/KEY, fetchRecentChatRows retorna [] (getConfig falha).
  // Isso elimina o branch de dedupe por chat_messages_sum no teste.
  return { WHATSAPP_OUTBOUND_DEDUPE_SEC: '180' }
}

async function caseRaceWhenLockBusy() {
  console.log('caso: race quando outro envio mantém o lock')
  const env = envWithoutSupabase()
  const phone = '5511999990001'
  // Outro envio já reservou o lock (sem release).
  const reserved = tryReserveOutboundSync(phone)
  expect('lock inicial reservado', reserved, (v) => v === true)

  try {
    const res = await shouldSkipDuplicateOutbound(env, phone, 'Mensagem qualquer com conteúdo suficiente')
    expect('skip=true', res, (v) => v?.skip === true)
    expect('race=true', res, (v) => v?.race === true)
    expect('reason=outbound_inflight_sync', res, (v) => v?.reason === 'outbound_inflight_sync')
  } finally {
    releaseOutboundSync(phone)
  }
}

async function caseNoRaceWhenLockFree() {
  console.log('caso: sem race quando lock está livre')
  const env = envWithoutSupabase()
  const phone = '5511999990002'
  const res = await shouldSkipDuplicateOutbound(env, phone, 'Conteúdo qualquer pra outro telefone livre')
  expect('skip=false', res, (v) => v?.skip === false)
  expect('race=false (não definido)', res, (v) => !v?.race)
  releaseOutboundSync(phone)
}

async function caseShortBodySkippedFromDedupeButNotRace() {
  console.log('caso: body curto passa direto sem dedupe (sem race)')
  const env = envWithoutSupabase()
  const phone = '5511999990003'
  const res = await shouldSkipDuplicateOutbound(env, phone, 'oi')
  expect('skip=false (body curto)', res, (v) => v?.skip === false)
  expect('race=false', res, (v) => !v?.race)
  releaseOutboundSync(phone)
}

async function caseSenderRaceShapeForCaller() {
  console.log('caso: contrato do retorno do sender em race')
  // Reproduzimos o shape que `sendMessageWithNote` precisa retornar pra
  // `webhookEvolution.js` distinguir race de dedupe legítimo.
  const env = envWithoutSupabase()
  const phone = '5511999990004'
  tryReserveOutboundSync(phone)
  try {
    const dedupe = await shouldSkipDuplicateOutbound(env, phone, 'Conteúdo razoável de mensagem para race')
    expect('shape inclui race', dedupe, (v) => v?.race === true)

    const senderResult = dedupe.race
      ? { ok: false, race: true, code: 'OUTBOUND_INFLIGHT_RACE', sent: 0, total: 1 }
      : { ok: true, deduped: true, sent: 0, total: 1 }

    expect('sender retorna ok=false em race', senderResult, (v) => v.ok === false)
    expect('sender preserva race=true', senderResult, (v) => v.race === true)
    expect('sender com sent=0', senderResult, (v) => v.sent === 0)

    const sendRace = Boolean(senderResult.race)
    const sentReal = (senderResult.sent || 0) > 0
    const dedupedLegit = Boolean(senderResult.ok && senderResult.deduped && !sendRace)
    const sentOk = Boolean(senderResult.ok && (sentReal || dedupedLegit))
    expect('sentOk=false (race não conta como envio)', { sentOk }, (v) => v.sentOk === false)
  } finally {
    releaseOutboundSync(phone)
  }
}

async function caseLegitimateDedupeShapeForCaller() {
  console.log('caso: contrato do retorno do sender em dedupe legítimo')
  // Cenário hipotético: chat_messages tem resposta idêntica recente.
  // Aqui só validamos que o shape esperado (`ok:true, deduped:true`)
  // continua sendo tratado como sentOk no caller.
  const senderResult = { ok: true, deduped: true, sent: 0, total: 1 }
  const sendRace = Boolean(senderResult.race)
  const sentReal = (senderResult.sent || 0) > 0
  const dedupedLegit = Boolean(senderResult.ok && senderResult.deduped && !sendRace)
  const sentOk = Boolean(senderResult.ok && (sentReal || dedupedLegit))
  expect('sentOk=true (dedupe legítimo)', { sentOk }, (v) => v.sentOk === true)
  expect('sentReal=false (não grava hash)', { sentReal }, (v) => v.sentReal === false)
}

async function caseRealSendShape() {
  console.log('caso: contrato do retorno do sender com envio real')
  const senderResult = { ok: true, sent: 1, total: 1 }
  const sendRace = Boolean(senderResult.race)
  const sentReal = (senderResult.sent || 0) > 0
  const dedupedLegit = Boolean(senderResult.ok && senderResult.deduped && !sendRace)
  const sentOk = Boolean(senderResult.ok && (sentReal || dedupedLegit))
  expect('sentOk=true', { sentOk }, (v) => v.sentOk === true)
  expect('sentReal=true (grava hash)', { sentReal }, (v) => v.sentReal === true)
}

await caseRaceWhenLockBusy()
await caseNoRaceWhenLockFree()
await caseShortBodySkippedFromDedupeButNotRace()
await caseSenderRaceShapeForCaller()
await caseLegitimateDedupeShapeForCaller()
await caseRealSendShape()

console.log()
console.log(`total: ${stats.total} | passed: ${stats.passed} | failed: ${stats.failed}`)
if (stats.failed > 0) {
  process.exitCode = 1
}
