/**
 * Prova que o rate limiter global do Kommo NUNCA ultrapassa 7 req/s, mesmo
 * recebendo uma rajada grande de chamadas de uma vez.
 *
 *   node scripts/test-kommo-rate-limiter.mjs
 */

import {
  runWithKommoRateLimit,
  pauseKommoRequests,
  getKommoRateLimiterSnapshot,
} from '../server/kommoRateLimiter.js'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ok  ${name}${extra ? ` — ${extra}` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

/** Maior nº de inícios em qualquer janela deslizante de 1000ms. */
function maxPerSecond(startTimes) {
  const sorted = [...startTimes].sort((a, b) => a - b)
  let max = 0
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j < sorted.length && sorted[j] - sorted[i] < 1000) j++
    max = Math.max(max, j - i)
  }
  return max
}

async function main() {
  // RPS default (5) com hard cap 6.
  process.env.KOMMO_MAX_RPS = '5'

  const N = 40
  const starts = []
  const t0 = Date.now()
  const jobs = Array.from({ length: N }, () =>
    runWithKommoRateLimit(async () => {
      starts.push(Date.now() - t0)
      // trabalho instantâneo — pior caso para rajada.
      return true
    }),
  )
  await Promise.all(jobs)

  const perSec = maxPerSecond(starts)
  console.log(`\n[burst] ${N} chamadas, pico observado = ${perSec} req/s`)
  check('nunca excede 7 req/s (limite do Kommo)', perSec <= 7, `pico=${perSec}`)
  check('respeita o hard cap (<= 6 req/s)', perSec <= 6, `pico=${perSec}`)
  check('todas as chamadas executaram', starts.length === N, `${starts.length}/${N}`)

  // Espaçamento mínimo entre inícios consecutivos ~ 200ms (5 req/s).
  const sortedStarts = [...starts].sort((a, b) => a - b)
  let minGap = Infinity
  for (let i = 1; i < sortedStarts.length; i++) {
    minGap = Math.min(minGap, sortedStarts[i] - sortedStarts[i - 1])
  }
  // tolerância de timer
  check('espaçamento mínimo ~>= 180ms entre inícios', minGap >= 180, `minGap=${minGap}ms`)

  // Backoff: ao pausar, nenhuma nova chamada inicia antes do fim da pausa.
  const PAUSE_MS = 600
  pauseKommoRequests(PAUSE_MS)
  const tPause = Date.now()
  let startedAt = null
  await runWithKommoRateLimit(async () => {
    startedAt = Date.now() - tPause
    return true
  })
  check('backoff respeitado (não inicia antes da pausa terminar)', startedAt >= PAUSE_MS - 40, `startedAt=${startedAt}ms`)

  console.log('\nsnapshot final:', JSON.stringify(getKommoRateLimiterSnapshot()))
  console.log(`\ntotal: ${pass + fail} | passed: ${pass} | failed: ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
