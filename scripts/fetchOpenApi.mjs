const url = process.env.SUPABASE_URL.replace(/\/$/, '')
const key = process.env.SUPABASE_KEY
const r = await fetch(`${url}/rest/v1/`, {
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/openapi+json',
  },
})
const spec = await r.json()
const paths = Object.keys(spec.paths || {})
const rpc = paths.filter((p) => p.includes('/rpc/'))
const tables = paths.filter((p) => !p.includes('/rpc/') && p !== '/')
const hits = paths.filter((p) => /schema|migration|app_settings|training/i.test(p))
console.log('hits', hits.join('\n'))
console.log('has agent_training', paths.includes('/agent_training_feedback'))
