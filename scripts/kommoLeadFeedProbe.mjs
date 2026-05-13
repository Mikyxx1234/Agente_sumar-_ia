/**
 * Compara o que o Kommo expõe em NOTAS vs EVENTOS para um lead.
 *
 * Uso (Node 20+):
 *   node --env-file=.env scripts/kommoLeadFeedProbe.mjs 19884275
 *
 * Ou exporte KOMMO_BASE_URL, KOMMO_ACCESS_TOKEN e passe o id como argv[2].
 *
 * Ajuda a confirmar: a mensagem do WhatsApp aparece em incoming_chat_message
 * mesmo quando a timeline mostra só "notas" common da integração.
 * (incoming_message em filter[type] costuma dar 400 no Kommo — não usamos aqui.)
 */

import { listLeadNotes, listLeadEvents } from '../server/kommoClient.js'

function preview(obj, max = 120) {
  try {
    const s = JSON.stringify(obj)
    return s.length > max ? `${s.slice(0, max)}…` : s
  } catch {
    return String(obj).slice(0, max)
  }
}

function extractEventText(ev) {
  const va = ev?.value_after
  if (va && typeof va === 'object' && !Array.isArray(va)) {
    const m = va.message || va.note || va
    const t = m?.text ?? m?.body ?? m?.content ?? va.text ?? va.body
    if (t != null && String(t).trim()) return String(t).trim()
  }
  if (Array.isArray(va)) {
    for (const item of va) {
      const m = item?.message || item
      const t = m?.text ?? m?.body ?? item?.text
      if (t != null && String(t).trim()) return String(t).trim()
    }
  }
  return ''
}

const leadId = Number(process.argv[2] || process.env.PROBE_LEAD_ID || 0)
if (!Number.isFinite(leadId) || leadId <= 0) {
  console.error('Informe o lead id: node --env-file=.env scripts/kommoLeadFeedProbe.mjs 19884275')
  process.exit(1)
}

const env = process.env
const notes = await listLeadNotes(env, leadId, { limit: 15, order: 'desc' })
const eventTypes = ['incoming_chat_message']
const events = await listLeadEvents(env, leadId, {
  limit: 25,
  entity: 'lead',
  types: eventTypes,
})

console.log('\n=== Kommo lead feed probe ===\n')
console.log(`lead=${leadId}`)
console.log(`KOMMO_BASE_URL=${(env.KOMMO_BASE_URL || '').replace(/\/$/, '')}\n`)

if (!notes.ok) {
  console.log('[notes] ERRO', notes.status, notes.error || notes.code)
} else {
  const arr = notes.notes || []
  console.log(`[notes] ok count=${arr.length} (últimas por id desc)\n`)
  for (const n of arr.slice(0, 8)) {
    const t = String(n?.note_type || '?')
    const p = n?.params || {}
    const txt =
      p.text ??
      p.body ??
      (typeof p.message === 'string' ? p.message : p.message?.text) ??
      ''
    const short = String(txt).replace(/\s+/g, ' ').trim().slice(0, 100)
    console.log(`  id=${n?.id} type=${t} text="${short}"`)
  }
}

console.log('')

if (!events.ok) {
  console.log('[events incoming_chat_message] ERRO', events.status, events.error || events.code)
} else {
  const arr = events.events || []
  console.log(`[events ${eventTypes.join('+')}] ok count=${arr.length}\n`)
  for (const e of arr.slice(0, 8)) {
    const txt = extractEventText(e)
    const short = txt.replace(/\s+/g, ' ').trim().slice(0, 100)
    console.log(`  id=${e?.id} type=${e?.type} created=${e?.created_at} text="${short}"`)
    if (!txt) console.log(`      value_after=${preview(e?.value_after, 140)}`)
  }
}

console.log(
  '\nSe aqui aparecer texto do WhatsApp em [events] mas não (ou errado) em [notes],',
  'o poll em mode=notes precisa do complemento de eventos (KOMMO_INBOUND_POLL_NOTES_ALSO_EVENTS, default true).\n',
)
