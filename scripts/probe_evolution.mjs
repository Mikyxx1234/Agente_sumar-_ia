const base = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '')
const key = process.env.EVOLUTION_API_KEY || ''
const inst = process.env.EVOLUTION_INSTANCE || ''
const instEnc = encodeURIComponent(inst)

if (!base || !key) { console.error('Faltam EVOLUTION_API_URL / EVOLUTION_API_KEY'); process.exit(1) }

const H = { apikey: key }
console.log(`base=${base}\ninstance="${inst}"\n`)

async function probe(label, path) {
  const r = await fetch(`${base}${path}`, { headers: H })
  const t = await r.text()
  console.log(`=== ${label} ===\nGET ${path}\n→ HTTP ${r.status}`)
  try { console.log(JSON.stringify(JSON.parse(t), null, 2).slice(0, 2000)) }
  catch { console.log(t.slice(0, 800)) }
  console.log('')
}

await probe('fetchInstances (todas)', '/instance/fetchInstances')
await probe(`connectionState`, `/instance/connectionState/${instEnc}`)
await probe(`webhook/find`, `/webhook/find/${instEnc}`)
