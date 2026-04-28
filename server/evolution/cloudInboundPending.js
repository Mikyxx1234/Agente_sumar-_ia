/**
 * Ponte para mensagens inbound na integração WhatsApp Business (Meta) na Evolution.
 *
 * Nesse canal, o webhook `messages.upsert` coloca em `key.remoteJid` o número do
 * NEGÓCIO (this.phoneNumber), não o do cliente. O telefone do lead vem em
 * `contacts.upsert` / `contacts.update` logo depois, com `remoteJid` = profile.phone.
 *
 * FIFO por instância Evolution (ordem em que a API emite os webhooks).
 */

/** @typedef {{ messageId: string|null, messageType: string|null, payload: object, ts: number }} PendingMsg */
/** @typedef {{ sessionId: string, ts: number }} OrphanContact */

/** @type {Map<string, PendingMsg[]>} */
const pendingByInstance = new Map()
/** @type {Map<string, OrphanContact[]>} */
const orphanContactsByInstance = new Map()

const MAX_QUEUE = 40
const MAX_AGE_MS = 120000

function pruneMessages(arr) {
  const now = Date.now()
  return arr.filter((x) => now - x.ts < MAX_AGE_MS).slice(-MAX_QUEUE)
}

function pruneOrphans(arr) {
  const now = Date.now()
  return arr.filter((x) => now - x.ts < MAX_AGE_MS).slice(-MAX_QUEUE)
}

/** @type {Map<string, number>} epoch ms — instância acabou de receber inbound Cloud aguardando contacts.* */
const cloudExpectsContactUntil = new Map()
const CONTACT_WINDOW_MS = 20000

export function markCloudBridgeExpectsContact(instance) {
  if (!instance) return
  cloudExpectsContactUntil.set(instance, Date.now() + CONTACT_WINDOW_MS)
}

export function shouldBufferOrphanContact(instance) {
  if (!instance) return false
  const until = cloudExpectsContactUntil.get(instance)
  if (!until || Date.now() > until) {
    cloudExpectsContactUntil.delete(instance)
    return false
  }
  return true
}

export function bufferOrphanContact(instance, customerSessionId) {
  if (!instance || !customerSessionId) return
  const oc = orphanContactsByInstance.get(instance) || []
  const nextO = pruneOrphans([...oc, { sessionId: customerSessionId, ts: Date.now() }])
  orphanContactsByInstance.set(instance, nextO)
}

export function clearCloudBridgeContactWindow(instance) {
  if (instance) cloudExpectsContactUntil.delete(instance)
}

/**
 * Mensagem inbound Cloud: enfileira o payload completo para extrair texto depois
 * (no evento de contato, que chega em seguida).
 *
 * @returns {{ mode: 'immediate', sessionId: string, pending: PendingMsg }|{ mode: 'queued' }|null}
 */
export function enqueueCloudInboundPending(instance, item) {
  if (!instance) return null
  const orphans = orphanContactsByInstance.get(instance) || []
  const prunedO = pruneOrphans(orphans)
  if (prunedO.length > 0) {
    const oc = prunedO.shift()
    if (prunedO.length === 0) orphanContactsByInstance.delete(instance)
    else orphanContactsByInstance.set(instance, prunedO)
    return { mode: 'immediate', sessionId: oc.sessionId, pending: { ...item, ts: Date.now() } }
  }
  const q = pendingByInstance.get(instance) || []
  const next = pruneMessages([...q, { ...item, ts: Date.now() }])
  pendingByInstance.set(instance, next)
  return { mode: 'queued' }
}

/**
 * Contato (upsert/update): retira 1 mensagem pendente e devolve session do cliente + pendência.
 *
 * @returns {{ pending: PendingMsg, sessionId: string }|null}
 */
export function matchContactToPending(instance, customerSessionId) {
  if (!instance || !customerSessionId) return null
  const q = pendingByInstance.get(instance) || []
  const pruned = pruneMessages(q)
  if (pruned.length === 0) return null
  const pending = pruned.shift()
  if (pruned.length === 0) pendingByInstance.delete(instance)
  else pendingByInstance.set(instance, pruned)
  return { pending, sessionId: customerSessionId }
}
