const PROBE = 'https://banco-agente-sumare.6tqx2r.easypanel.host/api/kommo-dispatcher/probe'
const leads = (process.argv[2] || '23895929,23870373,23864275').split(',').map((s) => s.trim())

for (const lid of leads) {
  const path = `/api/kommo/messages/by-lead/${lid}?limit=8&order=desc`
  const r = await fetch(`${PROBE}?path=${encodeURIComponent(path)}`)
  const j = await r.json()
  const payload = j.json
  const msgs = Array.isArray(payload) ? payload : payload?.messages || payload?.data || []
  console.log(`\nlead=${lid} http=${r.status} msgs=${Array.isArray(msgs) ? msgs.length : typeof payload}`)
  if (Array.isArray(msgs)) {
    for (const m of msgs.slice(0, 6)) {
      const txt = String(m.message_text || m.text || '').replace(/\s+/g, ' ').slice(0, 70)
      console.log(`  ${m.sender_type || m.direction || '?'} | ${txt}`)
    }
  } else {
    console.log('  raw:', JSON.stringify(payload).slice(0, 200))
  }
}
