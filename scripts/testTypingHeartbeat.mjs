/**
 * Testa o "digitando..." mantendo o indicador ativo via heartbeat:
 * dispara read+typing_indicator a cada N segundos, ciclando entre
 * múltiplos wamids recentes. Depois envia a mensagem real.
 *
 * Uso:
 *   node --env-file=.env.test.tmp scripts/testTypingHeartbeat.mjs <leadId> <duracao_seg> <intervalo_seg> "<msg>"
 */

import { sendCloudTypingRead, sendMessageWithNote } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'

const LEAD_ID = process.argv[2] || '19884275'
const TOTAL_SEC = Number(process.argv[3]) || 20
const INTERVAL_SEC = Number(process.argv[4]) || 3
const MESSAGE = process.argv[5]
  || 'Terceira tentativa: agora estou pingando "digitando..." várias vezes durante 20s. Apareceu agora?'

async function kommoGet(path) {
  const base = (process.env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = process.env.KOMMO_ACCESS_TOKEN
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Kommo ${path} → ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

function pickPhone(contact) {
  const fields = contact?.custom_fields_values || []
  for (const f of fields) {
    if (f?.field_code === 'PHONE' || /phone/i.test(f?.field_name || '')) {
      const v = f?.values?.[0]?.value
      if (v) return String(v)
    }
  }
  return null
}

async function fetchRecentWamids(jid, limit) {
  const url = `${(process.env.EVOLUTION_API_URL || '').replace(/\/$/, '')}/chat/findMessages/${process.env.EVOLUTION_INSTANCE}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY },
    body: JSON.stringify({ where: { key: { remoteJid: jid, fromMe: false } }, limit }),
  })
  const data = await res.json()
  const list = Array.isArray(data) ? data : (data?.records || data?.messages?.records || data?.messages || [])
  return list
    .map((m) => m?.key?.id)
    .filter((id) => typeof id === 'string' && id.startsWith('wamid.'))
}

async function main() {
  console.log('────────────────────────────────────────')
  console.log(`Lead: ${LEAD_ID} | duração: ${TOTAL_SEC}s | intervalo: ${INTERVAL_SEC}s`)

  const lead = await kommoGet(`/api/v4/leads/${LEAD_ID}?with=contacts`)
  const contactsInLead = lead?._embedded?.contacts || []
  let phone = null
  for (const c of contactsInLead) {
    const detail = await kommoGet(`/api/v4/contacts/${c.id}`)
    phone = pickPhone(detail)
    if (phone) break
  }
  if (!phone) throw new Error('Sem telefone')
  const jid = phone.includes('@') ? phone : `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`
  console.log(`telefone: ${phone}`)

  const wamids = await fetchRecentWamids(jid, 50)
  if (!wamids.length) throw new Error('Nenhum wamid encontrado')
  console.log(`wamids disponíveis: ${wamids.length} (vou ciclar)`)

  const executionId = generateExecutionId()
  console.log(`executionId: ${executionId}`)

  const startTs = Date.now()
  const endTs = startTs + TOTAL_SEC * 1000
  let i = 0

  console.log('▶ heartbeat de typing iniciado')
  let stopHeartbeat = false

  const heartbeat = (async () => {
    while (!stopHeartbeat && Date.now() < endTs) {
      const wamid = wamids[i % wamids.length]
      i += 1
      const elapsed = ((Date.now() - startTs) / 1000).toFixed(1)
      const r = await sendCloudTypingRead(process.env, { messageId: wamid })
      console.log(`  [${elapsed}s] ping ${i} (${wamid.slice(-12)}) → ${r.ok ? 'ok' : `FAIL ${r.error || r.status}`}`)
      await new Promise((res) => setTimeout(res, INTERVAL_SEC * 1000))
    }
  })()

  await new Promise((res) => setTimeout(res, TOTAL_SEC * 1000))
  stopHeartbeat = true
  await heartbeat

  console.log('■ heartbeat parado, enviando mensagem real')
  const sRes = await sendMessageWithNote(process.env, {
    telefone: phone,
    text: MESSAGE,
    leadId: Number(LEAD_ID),
    executionId,
  })
  console.log(`send → ok=${sRes.ok}, sent=${sRes.sent}/${sRes.total}, msgId=${sRes.steps?.[0]?.messageId}`)
  console.log('────────────────────────────────────────')
  console.log('FIM. executionId:', executionId)
}

main().catch((e) => { console.error('ERRO', e); process.exit(1) })
