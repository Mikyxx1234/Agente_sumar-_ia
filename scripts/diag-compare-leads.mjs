import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}
const base = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
const token = env.KOMMO_ACCESS_TOKEN || ''

async function lead(id) {
  const r = await fetch(`${base}/api/v4/leads/${id}?with=contacts`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  })
  return r.json()
}

function summarize(l) {
  const cf = {}
  for (const f of l.custom_fields_values || []) {
    const vals = (f.values || []).map((v) => v.value).join(' | ')
    cf[f.field_name || f.field_id] = vals
  }
  const tags = (l._embedded?.tags || []).map((t) => t.name)
  return {
    id: l.id,
    name: l.name,
    status_id: l.status_id,
    pipeline_id: l.pipeline_id,
    responsible_user_id: l.responsible_user_id,
    tags,
    custom_fields: cf,
  }
}

const a = summarize(await lead(23841399)) // atendido
const b = summarize(await lead(23875217)) // nao atendido

console.log('===== WILLIAM #23841399 (ATENDIDO) =====')
console.log(JSON.stringify(a, null, 2))
console.log('\n===== RAPHAEL #23875217 (NAO ATENDIDO) =====')
console.log(JSON.stringify(b, null, 2))

console.log('\n===== DIFERENCAS =====')
console.log('status_id:', a.status_id, 'vs', b.status_id, a.status_id === b.status_id ? '(igual)' : '(DIFERE)')
console.log('responsible_user_id:', a.responsible_user_id, 'vs', b.responsible_user_id, a.responsible_user_id === b.responsible_user_id ? '(igual)' : '(DIFERE)')
console.log('tags A:', a.tags.join(', ') || '(nenhuma)')
console.log('tags B:', b.tags.join(', ') || '(nenhuma)')
const keys = new Set([...Object.keys(a.custom_fields), ...Object.keys(b.custom_fields)])
console.log('\ncampos personalizados (A=William | B=Raphael):')
for (const k of keys) {
  const va = a.custom_fields[k] ?? '(vazio)'
  const vb = b.custom_fields[k] ?? '(vazio)'
  const mark = va === vb ? '   ' : '>> '
  console.log(`${mark}${k}: A="${va}"  B="${vb}"`)
}
