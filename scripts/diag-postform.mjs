import fs from 'node:fs'
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('='); const k = line.slice(0, i).trim()
  if (!process.env[k]) process.env[k] = line.slice(i + 1).trim()
}
const env = process.env
const LEAD = Number(process.argv[2] || 23875607)

const { detectFormSumarRecebidoNoKommo } = await import('../server/inscricaoPostFormPipeline.js')
const { fetchLeadFormSnapshot, validateFormSnapshot } = await import('../server/inscricaoKommoFields.js')
const { listLeadEvents } = await import('../server/kommoClient.js')

console.log('=== SNAPSHOT do lead', LEAD, '===')
const snap = await fetchLeadFormSnapshot(env, LEAD)
console.log('ok:', snap.ok)
console.log('snapshot:', JSON.stringify(snap.snapshot, null, 2))
if (snap.ok && snap.snapshot) {
  const val = validateFormSnapshot(env, snap.snapshot)
  console.log('validação:', JSON.stringify(val))
}

console.log('\n=== EVENTOS recentes (campo) ===')
try {
  const fromTs = Math.floor((Date.now() - 6 * 3600000) / 1000)
  const ev = await listLeadEvents(env, LEAD, { types: [], limit: 80, fromTs })
  console.log('ok:', ev.ok, 'total:', ev.events?.length)
  const counts = {}
  for (const e of ev.events || []) counts[e.type] = (counts[e.type] || 0) + 1
  console.log('tipos:', JSON.stringify(counts))
} catch (e) { console.log('listLeadEvents erro:', e.message) }

console.log('\n=== DETECÇÃO (schedulerTick=true) ===')
console.log(JSON.stringify(await detectFormSumarRecebidoNoKommo(env, LEAD, { schedulerTick: true }), null, 2))
console.log('\n=== DETECÇÃO (schedulerTick=false) ===')
console.log(JSON.stringify(await detectFormSumarRecebidoNoKommo(env, LEAD, { schedulerTick: false }), null, 2))
