import fs from 'node:fs'
import { runMatriculaCaptacaoAfterForm } from '../server/matriculaCaptacaoPipeline.js'
import { updateDadosCliente } from '../server/dadosClienteStore.js'

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
const polo = process.argv[5] || 'Barra Funda'
const unidade = process.argv[6] || 'ED_SP_P5'

console.log(`\n=== RECUPERAÇÃO Farmácia Semipresencial lead ${leadId} (${telefone}) ===`)

// 1) Limpa estado de captação antigo (candidato FARM_EAD quebrado + dedupe de link)
const clear = await updateDadosCliente(env, {
  telefone,
  fields: {
    captacao_candidato_id: null,
    captacao_pending_candidato_id: null,
    captacao_curso_codigo: null,
    captacao_curso_nome: null,
    captacao_contrato_link: null,
    captacao_contrato_link_at: null,
    inscricao_form_status: null,
  },
})
console.log('clear captacao fields:', clear.ok, clear.status)

// 2) Regenera pelo pipeline real (agora resolve FARM_SEMI + turno=SEMIPRESENCIAL)
const res = await runMatriculaCaptacaoAfterForm(env, {
  telefone,
  leadId,
  pushName: '',
  executionId: 'recover-farm-semi-' + Date.now(),
  confirmedNovaInscricao: true,
  snapshotOverride: { email, unidade, polo_inscricao: polo },
})

console.log('\nRESULTADO:')
console.log(JSON.stringify(res, null, 2))
