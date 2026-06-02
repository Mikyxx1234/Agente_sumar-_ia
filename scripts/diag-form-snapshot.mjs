import fs from 'node:fs'
import { fetchLeadFormSnapshot, validateFormSnapshot } from '../server/inscricaoKommoFields.js'
import { resolveCursoCodigo } from '../server/sumareCaptacaoClient.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const leadId = process.argv[2] || '23841399'
console.log(`\n=== snapshot do formulário no Kommo — lead ${leadId} ===`)

const snap = await fetchLeadFormSnapshot(env, leadId)
if (!snap.ok) {
  console.log('FALHOU:', snap.error)
  process.exit(1)
}
console.log('snapshot:', JSON.stringify(snap.snapshot, null, 2))

const val = validateFormSnapshot(env, snap.snapshot)
console.log('\nvalidação:', JSON.stringify(val))

let cursoCode = ''
try {
  cursoCode = resolveCursoCodigo(snap.snapshot.curso_inscricao, env)
} catch (e) {
  cursoCode = `erro: ${e.message}`
}
console.log(`curso "${snap.snapshot.curso_inscricao}" -> código API: "${cursoCode || '(vazio — cairia no DB/default)'}"`)
