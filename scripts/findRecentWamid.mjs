/**
 * Busca o wamid mais recente recebido do JID alvo, consultando a Evolution.
 * Em modo Cloud API, o data.key.id armazenado lá é o wamid da Meta.
 */

const URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '')
const KEY = process.env.EVOLUTION_API_KEY
const INST = process.env.EVOLUTION_INSTANCE
const PHONE = process.argv[2] || '5511945722117'
const JID = PHONE.includes('@') ? PHONE : `${PHONE.replace(/[^0-9]/g, '')}@s.whatsapp.net`

async function tryEndpoint(path, body) {
  const url = `${URL}${path}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY },
      body: JSON.stringify(body),
    })
    const raw = await res.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
    return { url, status: res.status, ok: res.ok, data, raw: raw.slice(0, 500) }
  } catch (e) {
    return { url, error: e.message }
  }
}

async function main() {
  console.log(`Buscando mensagens recentes de ${JID} na Evolution (${INST})...`)

  const variants = [
    { path: `/chat/findMessages/${INST}`, body: { where: { key: { remoteJid: JID, fromMe: false } }, limit: 5 } },
    { path: `/chat/findMessages/${INST}`, body: { where: { key: { remoteJid: JID } }, limit: 5 } },
    { path: `/chat/findMessages/${INST}`, body: { remoteJid: JID, fromMe: false, limit: 5 } },
    { path: `/message/findMessages/${INST}`, body: { where: { key: { remoteJid: JID, fromMe: false } }, limit: 5 } },
  ]

  for (const v of variants) {
    const r = await tryEndpoint(v.path, v.body)
    console.log(`\n[${r.status}] POST ${v.path}`)
    console.log('  body:', JSON.stringify(v.body))
    if (r.ok && r.data) {
      const list = Array.isArray(r.data) ? r.data : (r.data?.records || r.data?.messages?.records || r.data?.messages || [])
      const arr = Array.isArray(list) ? list : []
      console.log(`  → ${arr.length} mensagens`)
      const fromUser = arr.filter((m) => m?.key?.fromMe === false)
      console.log(`  → ${fromUser.length} do cliente`)
      if (fromUser[0]) {
        console.log('  PRIMEIRA do cliente:')
        console.log('    key.id        :', fromUser[0]?.key?.id)
        console.log('    messageType   :', fromUser[0]?.messageType)
        console.log('    messageTimestamp:', fromUser[0]?.messageTimestamp)
        return
      }
    } else {
      console.log('  raw:', r.raw || r.error)
    }
  }
}

main().catch((e) => { console.error('ERRO', e); process.exit(1) })
