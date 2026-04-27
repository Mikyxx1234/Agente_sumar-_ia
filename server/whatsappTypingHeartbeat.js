/**
 * Mantém o "digitando..." ativo por mais tempo enviando read+typing_indicator
 * em loop, ciclando por wamids recentes da sessão.
 *
 * Por que loop:
 *   A Cloud API documenta "until 25s OR next reply, whichever first", mas
 *   o cliente WhatsApp na prática às vezes encerra a animação antes. Re-
 *   pinging força o cliente a manter o indicador visível enquanto a IA
 *   processa.
 *
 * Por que ciclar wamids:
 *   A Meta só aceita typing+read pra wamids dos últimos minutos. Se o
 *   wamid mais recente foi "consumido" e não dá mais resposta esperada,
 *   o próximo ping cai pro próximo. Garante robustez.
 *
 * Uso:
 *   const hb = startTypingHeartbeat(env, wamids, { intervalMs: 4000 })
 *   try { await runAgent(...); } finally { hb.stop() }
 */

import { sendCloudTypingRead } from './whatsappSender.js'

/**
 * @param {Record<string,string>} env
 * @param {string[]} wamids                 wamids da sessão, mais recentes primeiro
 * @param {object}   [opts]
 * @param {number}   [opts.intervalMs=4000] tempo entre pings
 * @param {number}   [opts.maxDurationMs=120000] hard stop pra evitar loop infinito
 * @param {(line:string)=>void} [opts.log]  logger opcional pra debugging
 * @returns {{ stop:()=>Promise<void> }}
 */
export function startTypingHeartbeat(env, wamids, opts = {}) {
  const interval = Math.max(1000, Number(opts.intervalMs) || 4000)
  const maxDur = Math.max(interval, Number(opts.maxDurationMs) || 120000)
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  if (!Array.isArray(wamids) || wamids.length === 0) {
    log('typing-hb: sem wamids, heartbeat NO-OP')
    return { stop: async () => {} }
  }

  let stopped = false
  let timer = null
  let i = 0
  const startedAt = Date.now()
  let inflight = Promise.resolve()

  function tick() {
    if (stopped) return
    if (Date.now() - startedAt >= maxDur) {
      log('typing-hb: maxDuration atingida, parando')
      stopped = true
      return
    }
    const wamid = wamids[i % wamids.length]
    i += 1
    inflight = sendCloudTypingRead(env, { messageId: wamid })
      .then((r) => {
        if (r.ok) log(`typing-hb ping ok (${wamid.slice(-12)})`)
        else log(`typing-hb ping fail (${wamid.slice(-12)}): ${r.error || r.status}`)
      })
      .catch((err) => log(`typing-hb ping ex: ${err.message}`))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, interval)
      })
  }

  // Primeiro ping imediato (pra typing aparecer cedo).
  tick()

  return {
    async stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      try { await inflight } catch {}
    },
  }
}
