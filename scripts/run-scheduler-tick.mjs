import fs from 'node:fs'
import { runSchedulerTick } from '../server/agentScheduler.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}
// força o gate de habilitação (mesmo comportamento do boot de produção)
if (!env.KOMMO_SCHEDULER_ENABLED) env.KOMMO_SCHEDULER_ENABLED = 'true'

const ticks = Number(process.argv[2] || 3)
for (let i = 1; i <= ticks; i++) {
  console.log(`\n===== TICK ${i}/${ticks} =====`)
  const stats = await runSchedulerTick(env)
  console.log('stats:', JSON.stringify(stats))
  if (i < ticks) await new Promise((r) => setTimeout(r, 12000))
}
