/**
 * Cadastra no sumare_captacao_curso os códigos Semipresenciais (_SEMI) que faltavam
 * para cursos só ofertados Semipresencial. Todos validados na API Captação
 * (gerar candidato retorna valorBoleto > 0):
 *   ENGP_SEMI 237 · FISIO_SEMI 227 · NUTR_SEMI 237 · ARUB_SEMI 257 · ENGC_SEMI 237
 *   ENGE_SEMI 237 · ENGM_SEMI 237 · TSAMB_SEMI 147 · SERV_SEMI 167
 * curso_nome casa com o catálogo/planilha (grad_preco) para o resolvedor encontrar.
 */
import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
const key = env.SUPABASE_KEY || ''
const table = env.SUMARE_CAPTACAO_CURSO_TABLE || 'sumare_captacao_curso'

const rows = [
  { codigo_original: 'ENGP_SEMI', codigo_base: 'ENGP', curso_nome: 'Engenharia de Produção' },
  { codigo_original: 'FISIO_SEMI', codigo_base: 'FISIO', curso_nome: 'Fisioterapia' },
  { codigo_original: 'NUTR_SEMI', codigo_base: 'NUTR', curso_nome: 'Nutrição' },
  { codigo_original: 'ARUB_SEMI', codigo_base: 'ARUB', curso_nome: 'Arquitetura e Urbanismo' },
  { codigo_original: 'ENGC_SEMI', codigo_base: 'ENGC', curso_nome: 'Engenharia Civil' },
  { codigo_original: 'ENGE_SEMI', codigo_base: 'ENGE', curso_nome: 'Engenharia Elétrica' },
  { codigo_original: 'ENGM_SEMI', codigo_base: 'ENGM', curso_nome: 'Engenharia Mecânica' },
  { codigo_original: 'TSAMB_SEMI', codigo_base: 'TSAMB', curso_nome: 'Saneamento Ambiental' },
  { codigo_original: 'SERV_SEMI', codigo_base: 'SERV', curso_nome: 'Serviço Social' },
].map((r) => ({ ...r, modalidade: 'Semipresencial', ativo: true, updated_at: new Date().toISOString() }))

const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?on_conflict=codigo_original`, {
  method: 'POST',
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  },
  body: JSON.stringify(rows),
})

console.log('upsert http', res.status, res.ok)
console.log(JSON.stringify(await res.json(), null, 2))
