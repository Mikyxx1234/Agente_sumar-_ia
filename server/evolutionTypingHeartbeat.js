/**
 * Heartbeat de "digitando..." via Evolution presence.
 *
 * Usado quando NÃO temos `wamid` (caso típico do modo `dispatcher`, onde a
 * mensagem do cliente vem do banco-kommo-dispatcher e não tem o wamid Meta).
 * Para cobrir o ciclo "debounce + IA + envio" sem quebrar a animação, a
 * Evolution presence (`composing`) precisa ser refire em loop — cada call
 * mantém o cliente vendo "digitando..." por ~6–10s.
 *
 * Uso:
 *   const hb = startEvolutionTypingHeartbeat(env, sessionId, { intervalMs: 5000 })
 *   try { await runAgent(...); } finally { hb.stop() }
 */

import { sendTyping } from './evolution/typingIndicator.js'

/**
 * @param {Record<string,string>} env
 * @param {string} jid                       sessionId (`...@s.whatsapp.net`) ou só dígitos
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=5000]    intervalo entre refires
 * @param {number} [opts.delayMs]            delay enviado à Evolution por refire (default = intervalMs + 2s)
 * @param {number} [opts.maxDurationMs=90000] hard stop pra evitar typing eterno
 * @param {(line:string)=>void} [opts.log]   logger opcional
 * @returns {{ stop:()=>Promise<void> }}
 */
export function startEvolutionTypingHeartbeat(env, jid, opts = {}) {
  const interval = Math.max(2000, Number(opts.intervalMs) || 5000)
  const delay = Math.max(2000, Number(opts.delayMs) || interval + 2000)
  const maxDur = Math.max(interval, Number(opts.maxDurationMs) || 90000)
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  if (!jid) {
    log('evo-typing-hb: sem jid, NO-OP')
    return { stop: async () => {} }
  }

  let stopped = false
  let timer = null
  const startedAt = Date.now()
  let inflight = Promise.resolve()
  let firedCount = 0

  function tick() {
    if (stopped) return
    if (Date.now() - startedAt >= maxDur) {
      log(`evo-typing-hb: maxDuration atingida após ${firedCount} pings, parando`)
      stopped = true
      return
    }
    inflight = sendTyping(env, { jid, presence: 'composing', delayMs: delay })
      .then((r) => {
        firedCount += 1
        if (r.ok) {
          log(`evo-typing-hb ping ok (#${firedCount})`)
        } else if (r.code === 'EVOLUTION_NOT_CONFIGURED') {
          log('evo-typing-hb: Evolution não configurada, parando heartbeat')
          stopped = true
        } else {
          log(`evo-typing-hb ping fail (#${firedCount}): ${r.error || r.status}`)
        }
      })
      .catch((err) => log(`evo-typing-hb ping ex: ${err.message}`))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, interval)
      })
  }

  tick()

  return {
    async stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      try { await inflight } catch {}
      // Sinaliza explicitamente que parou de digitar (evita typing fantasma
      // se a próxima mensagem demorar a chegar).
      try {
        await sendTyping(env, { jid, presence: 'paused', delayMs: 0 })
      } catch {}
    },
  }
}
