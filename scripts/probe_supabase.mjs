const key = process.env.SUPABASE_KEY
const url = process.env.SUPABASE_URL
const H = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' }

const r = await fetch(`${url}/rest/v1/`, { headers: H })
const spec = await r.json()

const targets = ['grad_info', 'grad_preco', 'pos_info', 'pos_preco', 'mensagens_ia']
for (const t of targets) {
  const def = spec.definitions?.[t]
  if (!def) { console.log(`\n=== ${t}: (não existe) ===`); continue }
  console.log(`\n=== ${t} ===`)
  if (def.required) console.log('  required:', def.required.join(', '))
  for (const [col, meta] of Object.entries(def.properties || {})) {
    const fmt = meta.format ? ` [${meta.format}]` : ''
    console.log(`  ${col.padEnd(16)} ${meta.type || '?'}${fmt}`)
  }
}

console.log('\n=== RPCs match_* (definições) ===')
for (const path of Object.keys(spec.paths || {})) {
  if (path.startsWith('/rpc/match_')) {
    const post = spec.paths[path]?.post
    const params = post?.parameters?.[0]?.schema?.properties || {}
    console.log(`\n${path}`)
    for (const [p, m] of Object.entries(params)) {
      console.log(`  ${p.padEnd(18)} ${m.type || '?'}${m.format ? ` [${m.format}]` : ''}`)
    }
  }
}

console.log('\n=== amostras ===')
const H2 = { apikey: key, Authorization: `Bearer ${key}` }
for (const t of targets) {
  const r2 = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, { headers: H2 })
  const body = await r2.text()
  console.log(`\n--- ${t} (HTTP ${r2.status}) ---\n${body.slice(0, 600)}`)
}
