import fs from 'node:fs'
import { runMatriculaCaptacaoAfterForm } from '../server/matriculaCaptacaoPipeline.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const telefone = process.argv[2] || '5511944690752'
const leadId = Number(process.argv[3] || 23841399)
const email = process.argv[4] || 'williamsilveira0204@gmail.com'

console.log(`\n=== matrícula manual lead ${leadId} (${telefone}) email=${email} ===`)

const res = await runMatriculaCaptacaoAfterForm(env, {
  telefone,
  leadId,
  pushName: 'William',
  executionId: 'manual-proceed-' + Date.now(),
  snapshotOverride: {
    email,
    unidade: 'ED_SP_P2',
    polo_inscricao: 'Barra Funda',
  },
})

console.log('\nRESULTADO:')
console.log(JSON.stringify(res, null, 2))
