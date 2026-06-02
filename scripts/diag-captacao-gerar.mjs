import fs from 'node:fs'
import { fetchLeadFormSnapshot } from '../server/inscricaoKommoFields.js'
import { buildGerarCandidatoQueryAsync, gerarCandidatoIngresso } from '../server/sumareCaptacaoClient.js'

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

const snap = await fetchLeadFormSnapshot(env, leadId)
const snapshot = { ...snap.snapshot, email, unidade: 'ED_SP_P2', polo_inscricao: 'Barra Funda' }
console.log('SNAPSHOT:', JSON.stringify(snapshot, null, 2))

const params = await buildGerarCandidatoQueryAsync(snapshot, telefone, env)
console.log('\nPARAMS enviados ao gerar:', JSON.stringify(params, null, 2))

const res = await gerarCandidatoIngresso(env, params)
console.log('\nRESPOSTA gerar:')
console.log('status:', res.status, 'ok:', res.ok)
console.log('raw:', res.raw)
