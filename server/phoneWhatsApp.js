/**
 * Normaliza dígitos do telefone (Kommo / CRM) para o "local part" do JID WhatsApp.
 * Evolution costuma usar E.164 Brasil: 55 + DDD + número → …@s.whatsapp.net
 * O Kommo muitas vezes guarda só DDD+número (10–11 dígitos), o que gerava outro
 * session_id no buffer e o scheduler não achava mensagens.
 */

/**
 * @param {string} digitsRaw — só dígitos ou string com máscara
 * @returns {string|null} local part (ex.: 5511999999999) ou null
 */
export function digitsToWhatsAppLocalPart(digitsRaw) {
  const digits = String(digitsRaw || '').replace(/[^0-9]/g, '')
  if (!digits) return null
  if (digits.startsWith('55') && digits.length >= 12) return digits
  if (digits.length >= 10 && digits.length <= 11) return `55${digits}`
  if (digits.length >= 12) return digits
  return digits
}

/**
 * @param {string} phone — telefone como veio do Kommo
 * @returns {string|null} sessionId tipo 5511...@s.whatsapp.net
 */
export function phoneToWhatsAppSessionId(phone) {
  const local = digitsToWhatsAppLocalPart(phone)
  if (!local) return null
  return `${local}@s.whatsapp.net`
}

/**
 * Variantes de sessionId para o mesmo número, cobrindo o "9º dígito" de celular
 * brasileiro. O Kommo frequentemente guarda o número numa forma (ex.: com o 9
 * extra: 5511920464401) e o WhatsApp/Evolution entrega o JID na outra (sem o 9:
 * 551120464401), gerando buffers em chaves diferentes — o scheduler lia o buffer
 * vazio e nunca respondia.
 *
 * Devolve a sessão primária (sempre o índice 0) e, quando o número é BR
 * (55 + DDD), também a variante com/sem o 9 logo após o DDD. Variantes que não
 * correspondem a nenhuma sessão real simplesmente não terão mensagens no buffer,
 * então gerá-las é seguro (o chamador escolhe a que tiver fila).
 *
 * @param {string} phone — telefone como veio do Kommo (ou JID)
 * @returns {string[]} sessionIds únicos; primário primeiro. Vazio se inválido.
 */
export function whatsAppSessionVariants(phone) {
  const primary = phoneToWhatsAppSessionId(phone)
  if (!primary) return []
  const variants = [primary]
  const local = primary.slice(0, primary.indexOf('@'))
  if (local.startsWith('55') && local.length >= 12) {
    const ddd = local.slice(2, 4)
    const rest = local.slice(4)
    let alt = null
    if (rest.length === 8) {
      // sem o 9 → adiciona a variante com o 9 logo após o DDD
      alt = `55${ddd}9${rest}@s.whatsapp.net`
    } else if (rest.length === 9 && rest.startsWith('9')) {
      // com o 9 → adiciona a variante sem o 9
      alt = `55${ddd}${rest.slice(1)}@s.whatsapp.net`
    }
    if (alt && !variants.includes(alt)) variants.push(alt)
  }
  return variants
}

/**
 * Converte qualquer remoteJid da Evolution/Baileys para a chave única do buffer.
 * - @c.us (legado) → mesmo número em @s.whatsapp.net
 * - Grupos @g.us etc. → devolve sem alterar (não usamos no scheduler por telefone)
 * - @lid sem telefone → devolve como está (scheduler por Kommo não achará; log no webhook)
 */
export function canonicalWhatsAppSessionId(jid) {
  if (!jid || typeof jid !== 'string') return null
  const s = jid.trim()
  const at = s.indexOf('@')
  if (at < 0) {
    const local = digitsToWhatsAppLocalPart(s)
    return local ? `${local}@s.whatsapp.net` : null
  }
  const rawLocal = s.slice(0, at)
  const domain = s.slice(at + 1).toLowerCase()

  if (domain === 'g.us' || domain === 'broadcast' || domain === 'newsletter') return s

  if (domain === 'lid') return s

  if (domain === 's.whatsapp.net' || domain === 'c.us') {
    const digitsOnly = rawLocal.replace(/[^0-9]/g, '')
    if (!digitsOnly) return s
    const local = digitsToWhatsAppLocalPart(digitsOnly)
    if (local) return `${local}@s.whatsapp.net`
  }

  return s
}
