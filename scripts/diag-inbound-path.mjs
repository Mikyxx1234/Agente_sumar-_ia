import fs from 'node:fs'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const base = (env.EP_BASE_URL || 'http://168.231.99.126:3000').replace(/\/$/, '')
const loginRes = await fetch(`${base}/api/trpc/auth.login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ json: { email: env.EP_EMAIL, password: env.EP_PASSWORD } }),
})
const token = (await loginRes.json())?.result?.data?.json?.token
const input = encodeURIComponent(JSON.stringify({ json: { projectName: 'banco', serviceName: 'agente_sumare' } }))
const insp = await fetch(`${base}/api/trpc/services.app.inspectService?input=${input}`, {
  headers: { Authorization: `Bearer ${token}` },
})
const envText = (await insp.json())?.result?.data?.json?.env ?? ''
const P = {}
for (const l of String(envText).split(/\r?\n/)) {
  const i = l.indexOf('=')
  if (i > 0) P[l.slice(0, i).trim()] = l.slice(i + 1)
}

const v = P.WHATSAPP_GRAPH_VERSION || 'v21.0'
console.log('=== META CLOUD (Graph API com token de PRODUCAO) ===')
console.log('phone_number_id:', P.WHATSAPP_PHONE_NUMBER_ID)
try {
  const r = await fetch(`https://graph.facebook.com/${v}/${P.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating,account_mode,messaging_limit_tier,platform_type,is_official_business_account`, {
    headers: { Authorization: `Bearer ${P.WHATSAPP_ACCESS_TOKEN}` },
  })
  console.log('phone status', r.status, await r.text())
} catch (e) { console.log('phone err', e.message) }

console.log('\n=== EVOLUTION (instancia / numero conectado) ===')
const eu = (P.EVOLUTION_API_URL || '').replace(/\/$/, '')
const inst = P.EVOLUTION_INSTANCE || P.EVOLUTION_INSTANCE_NAME
console.log('url set:', Boolean(eu), 'instance:', inst)
try {
  const r = await fetch(`${eu}/instance/fetchInstances?instanceName=${encodeURIComponent(inst)}`, {
    headers: { apikey: P.EVOLUTION_API_KEY },
  })
  const txt = await r.text()
  let j; try { j = JSON.parse(txt) } catch { j = txt }
  const arr = Array.isArray(j) ? j : [j]
  for (const it of arr) {
    const o = it?.instance || it
    console.log('  instance:', JSON.stringify({ name: o?.instanceName || o?.name, state: o?.connectionStatus || o?.state || o?.status, owner: o?.owner || o?.ownerJid || o?.number || o?.profileName }))
  }
} catch (e) { console.log('evolution err', e.message) }

console.log('\n=== EVOLUTION findMessages por numero ===')
for (const num of ['5511944690752', '5511993537209']) {
  try {
    const r = await fetch(`${eu}/chat/findMessages/${encodeURIComponent(inst)}`, {
      method: 'POST',
      headers: { apikey: P.EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ where: { key: { remoteJid: `${num}@s.whatsapp.net` } }, limit: 5 }),
    })
    const txt = await r.text()
    let j; try { j = JSON.parse(txt) } catch { j = txt }
    const msgs = j?.messages?.records || j?.messages || j?.records || (Array.isArray(j) ? j : [])
    const n = Array.isArray(msgs) ? msgs.length : 'shape?'
    let inbound = 0, outbound = 0
    const inboundTxts = []
    if (Array.isArray(msgs)) for (const m of msgs) {
      if (m?.key?.fromMe) outbound++
      else { inbound++; const tx = m?.message?.conversation || m?.message?.extendedTextMessage?.text || ''; if (tx) inboundTxts.push(tx.slice(0, 30)) }
    }
    console.log(`  ${num}: http=${r.status} total=${n} inbound(cliente)=${inbound} outbound(agente)=${outbound}`)
    if (inboundTxts.length) console.log('    inbound ex:', JSON.stringify(inboundTxts.slice(0, 5)))
  } catch (e) { console.log(`  ${num} err`, e.message) }
}

console.log('\n=== EVOLUTION whatsappNumbers (numero valido no WhatsApp?) ===')
try {
  const r = await fetch(`${eu}/chat/whatsappNumbers/${encodeURIComponent(inst)}`, {
    method: 'POST', headers: { apikey: P.EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ numbers: ['5511944690752', '5511993537209'] }),
  })
  console.log('  status', r.status, (await r.text()).slice(0, 300))
} catch (e) { console.log('  err', e.message) }

console.log('\n=== EVOLUTION webhook config da instancia ===')
try {
  const r = await fetch(`${eu}/webhook/find/${encodeURIComponent(inst)}`, { headers: { apikey: P.EVOLUTION_API_KEY } })
  console.log('  status', r.status, (await r.text()).slice(0, 400))
} catch (e) { console.log('  err', e.message) }
