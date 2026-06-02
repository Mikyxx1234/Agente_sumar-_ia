import fs from 'node:fs'
import { gerarCandidatoIngresso } from '../server/sumareCaptacaoClient.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const baseParams = {
  utmSource: '', utmCampaign: '', utmMedium: '', planoPgto: '', quemIndicou: '',
  localInscricao: '', dispositivo: '', raAntigo: '', cursoAntigo: '', instituicaoAntiga: '',
  cpf: '48281105852',
  celular: '(11) 94469-0752',
  nomeCompl: 'william santos silveira',
  email: 'williamsilveira0204@gmail.com',
  dataNasc: '1999-04-02',
  sexo: 'M',
  turno: 'EAD',
  tipoIngresso: 'Vestibular',
  sumareComVc: 'N',
}

const cases = [
  { label: 'GAST_EAD + ED_SP_P5', curso: 'GAST_EAD', unidade: 'ED_SP_P5' },
  { label: 'GAST_EAD + ED_SP_P2', curso: 'GAST_EAD', unidade: 'ED_SP_P2' },
]

for (const c of cases) {
  const res = await gerarCandidatoIngresso(env, { ...baseParams, curso: c.curso, unidade: c.unidade })
  const msg = (String(res.raw || '').match(/<b>Message<\/b>\s*([^<]+)/) || [])[1] || (res.ok ? 'OK' : 'sem mensagem')
  console.log(`\n[${c.label}] status=${res.status} ok=${res.ok}`)
  console.log('  ->', msg.trim().slice(0, 200))
  if (res.ok) console.log('  data:', JSON.stringify(res.data).slice(0, 300))
}
