/**
 * Roda a varredura de reativação por inbound (server/leadReactivation.js).
 *
 *   node scripts/run-reactivation.mjs --dry-run
 *   node scripts/run-reactivation.mjs --apply --cap 40 --max-age-hours 24
 *
 * Sem --apply é dry-run. Após --apply, rode o tick do scheduler para responder:
 *   node scripts/run-scheduler-tick.mjs 2
 */
import fs from 'node:fs'
import { reactivateOrphanLeads, isReactivationEnabled } from '../server/leadReactivation.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const args = process.argv.slice(2)
const dryRun = !args.includes('--apply')
const cap = Number(args.find((a, i) => args[i - 1] === '--cap')) || 40
const ageH = Number(args.find((a, i) => args[i - 1] === '--max-age-hours')) || 24

if (!isReactivationEnabled(env)) {
  console.log('LEAD_REACTIVATION_ENABLED=false — reativação desligada. Abortando.')
  process.exit(0)
}

console.log(`modo=${dryRun ? 'DRY-RUN' : 'APPLY'} cap=${cap} maxAge=${ageH}h`)
const stats = await reactivateOrphanLeads(env, { dryRun, cap, maxAgeMs: ageH * 3600 * 1000 })
console.log('\n--- resumo ---')
console.log(JSON.stringify(stats, null, 2))
if (dryRun) console.log('\n(nada foi movido — use --apply para aplicar)')
else console.log('\nAgora rode: node scripts/run-scheduler-tick.mjs 2  (para o agente responder)')
