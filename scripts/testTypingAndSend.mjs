/**
 * Teste manual:
 *   1) Busca o lead pelo ID no Kommo e descobre o telefone do contato.
 *   2) Dispara presença "composing" via Evolution (cliente vê "digitando...").
 *   3) Espera N segundos (pra você visualizar o typing).
 *   4) Envia uma mensagem real via WhatsApp Cloud API + nota no Kommo.
 *
 * Uso:
 *   node --env-file=.env.test.tmp scripts/testTypingAndSend.mjs <leadId> [mensagem] [espera_seg]
 */

import { sendTyping } from '../server/evolution/typingIndicator.js'
import { sendMessageWithNote, sendCloudTypingRead } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'

const LEAD_ID = process.argv[2] || '19884275'
const MESSAGE = process.argv[3]
  || 'Olá! Esse é um teste do indicador "digitando..." — o sistema da IA está pronto para conversar com você. 😊'
const WAIT_SEC = Number(process.argv[4]) || 6

async function kommoGet(path) {
  const base = (process.env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = process.env.KOMMO_ACCESS_TOKEN
  const res = await fetch(`${base}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    throw new Error(`Kommo ${path} → ${res.status}: ${typeof text === 'string' ? text.slice(0, 300) : ''}`)
  }
  return data
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

async function main() {
  console.log('────────────────────────────────────────')
  console.log(`Lead alvo: ${LEAD_ID}`)
  console.log('1) Buscando lead no Kommo (com contatos)...')

  const lead = await kommoGet(`/api/v4/leads/${LEAD_ID}?with=contacts`)
  const contactsInLead = lead?._embedded?.contacts || []
  if (!contactsInLead.length) {
    throw new Error('Lead não tem contato vinculado.')
  }

  let phone = null
  for (const c of contactsInLead) {
    const detail = await kommoGet(`/api/v4/contacts/${c.id}`)
    phone = pickPhone(detail)
    if (phone) break
  }
  if (!phone) throw new Error('Nenhum telefone encontrado nos contatos do lead.')
  console.log(`   telefone: ${phone}`)

  const executionId = generateExecutionId()
  console.log(`   executionId: ${executionId}`)

  console.log('2a) Buscando wamid mais recente do cliente na Evolution...')
  let wamid = null
  try {
    const r = await fetch(`${(process.env.EVOLUTION_API_URL || '').replace(/\/$/, '')}/chat/findMessages/${process.env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY },
      body: JSON.stringify({
        where: { key: { remoteJid: phone.includes('@') ? phone : `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`, fromMe: false } },
        limit: 1,
      }),
    })
    const data = await r.json()
    const list = Array.isArray(data) ? data : (data?.records || data?.messages?.records || data?.messages || [])
    wamid = list?.[0]?.key?.id || null
    console.log(`   wamid: ${wamid}`)
  } catch (e) {
    console.warn('   falha buscando wamid:', e.message)
  }

  console.log('2b) Disparando typing via Cloud API (read receipt + typing_indicator)')
  let tRes
  if (wamid && (wamid.startsWith('wamid.') || wamid.startsWith('wamid_'))) {
    tRes = await sendCloudTypingRead(process.env, { messageId: wamid })
    console.log('   cloud typing →', JSON.stringify(tRes))
  } else {
    console.log('   sem wamid válido — fallback Evolution presence')
    tRes = await sendTyping(process.env, { jid: phone, presence: 'composing', delayMs: Math.max(WAIT_SEC * 1000, 5000) })
    console.log('   evo typing →', JSON.stringify(tRes))
  }

  console.log(`3) Esperando ${WAIT_SEC}s (cliente deveria estar vendo "digitando...")`)
  await new Promise((r) => setTimeout(r, WAIT_SEC * 1000))

  console.log('4) Enviando mensagem real via WhatsApp Cloud API + nota no Kommo')
  const sRes = await sendMessageWithNote(process.env, {
    telefone: phone,
    text: MESSAGE,
    leadId: Number(LEAD_ID),
    executionId,
  })
  console.log('   send →', JSON.stringify(sRes, null, 2))
  console.log('────────────────────────────────────────')
  console.log('FIM. executionId:', executionId)
}

main().catch((err) => {
  console.error('ERRO:', err)
  process.exit(1)
})
