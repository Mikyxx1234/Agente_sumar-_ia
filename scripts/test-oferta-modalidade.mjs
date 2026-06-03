import fs from 'node:fs'
import { buildGerarCandidatoQueryAsync } from '../server/sumareCaptacaoClient.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const tel = '5511944690752'
const casos = [
  { curso_inscricao: 'Farmácia', polo_inscricao: 'Barra Funda' },
  { curso_inscricao: 'Administração', polo_inscricao: 'Barra Funda' },
  { curso_inscricao: 'Ciências Contábeis', polo_inscricao: 'Tatuapé' },
  { curso_inscricao: 'História', polo_inscricao: 'Santana' },
  { curso_inscricao: 'Pedagogia', polo_inscricao: 'Barra Funda' },
  { curso_inscricao: 'FARM_SEMI', polo_inscricao: 'Barra Funda' },
  { curso_inscricao: 'ECON_EAD', polo_inscricao: 'Barra Funda' },
]

for (const c of casos) {
  const snap = {
    ...c,
    nome: 'Teste',
    cpf: '28314719072',
    email: 'teste@exemplo.com',
    data_nasc: '2000-09-08',
    sexo: 'M',
  }
  const p = await buildGerarCandidatoQueryAsync(snap, tel, env)
  console.log(
    `${String(c.curso_inscricao).padEnd(22)} -> curso=${String(p.curso).padEnd(12)} turno=${String(p.turno).padEnd(16)} unidade=${p.unidade}`,
  )
}
