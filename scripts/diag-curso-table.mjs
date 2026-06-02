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

const res = await fetch(
  `${url}/rest/v1/${table}?select=codigo_original,codigo_base,curso_nome,modalidade,ativo&curso_nome=ilike.*gastr*`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
)
console.log('status', res.status)
console.log(JSON.stringify(await res.json(), null, 2))
