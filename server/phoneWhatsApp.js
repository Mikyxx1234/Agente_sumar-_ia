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
