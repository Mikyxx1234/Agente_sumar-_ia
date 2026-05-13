/**
 * Uso:
 *   KOMMO_BASE_URL=... KOMMO_ACCESS_TOKEN=... node scripts/kommoTalksProbe.mjs 19884275
 * Ou (evita JWT no histórico do shell): token num ficheiro de uma linha, apagado após ler:
 *   node scripts/kommoTalksProbe.mjs 19884275 path/para/token.txt
 */
import { readFileSync, unlinkSync } from 'fs'
import { tryListTalksForLead, getTalkById, getLeadContactIds, listContactChats } from '../server/kommoClient.js'

const leadId = Number(process.argv[2] || '19884275')
const tokenFile = process.argv[3]
const env = { ...process.env }
if (tokenFile) {
  const tok = readFileSync(tokenFile, 'utf8').trim()
  if (tok) env.KOMMO_ACCESS_TOKEN = tok
  try {
    unlinkSync(tokenFile)
  } catch {
    /* ignore */
  }
}

const contactIds = await getLeadContactIds(env, leadId)
console.log('contactIds do lead', contactIds.join(', ') || '(nenhum)')
for (const cid of contactIds) {
  const cc = await listContactChats(env, cid)
  console.log(`listContactChats contact=${cid}`, cc.ok ? `ok chats=${(cc.chats || []).length}` : `erro ${cc.error}`)
  for (const ch of cc.chats || []) {
    console.log('  chat_id=', ch.chat_id)
  }
}

const listed = await tryListTalksForLead(env, leadId)
console.log('tryListTalksForLead:', listed.ok !== false ? 'ok' : 'fail', 'count=', listed.talks?.length ?? 0)
if (listed.error) console.log('list error:', listed.error)

const talks = listed.talks || []
if (talks.length && !talks[0]?.id && !talks[0]?.talk_id) {
  console.log('Debug primeiro item (keys):', Object.keys(talks[0] || {}))
  console.log(JSON.stringify(talks[0], null, 2).slice(0, 1200))
}

function rowTalkId(row) {
  if (row == null) return null
  const v = row.id ?? row.talk_id
  return v != null && v !== '' ? v : null
}

const leadTalk =
  talks.find((x) => String(x?.entity_type || '').toLowerCase() === 'lead' && Number(x?.entity_id) === leadId) ||
  talks[0]

const rawTalkId = rowTalkId(leadTalk)
if (rawTalkId == null) {
  console.log('\nNenhum talk com id/talk_id na lista filtrada (use contactChats acima ou GET /api/v4/contacts/chats).')
  process.exit(0)
}

const detail = await getTalkById(env, rawTalkId)
if (!detail.ok) {
  console.log('getTalkById falhou:', detail.error || detail.status)
  process.exit(1)
}

const talk = detail.talk || {}
console.log('\n--- Talk escolhido (primeiro do lead ou primeiro da lista) ---')
console.log(JSON.stringify({ talk_id: String(rawTalkId), chat_id: talk.chat_id, contact_id: talk.contact_id, entity_id: talk.entity_id, entity_type: talk.entity_type, origin: talk.origin }, null, 2))

console.log(
  '\nNota: o texto das mensagens WhatsApp NÃO vem deste GET; precisa de Chats API (KOMMO_CHANNEL_SECRET + KOMMO_CHANNEL_SCOPE_ID) em /v2/origin/custom/.../history.',
)
