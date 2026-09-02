/**
 * Extrai CPF, e-mail e data de nascimento de texto livre do lead.
 * Só devolve valor válido — o write no card decide se o campo ainda está vazio.
 */

const EMAIL_RX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/
const DATE_BR_RX = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/
const DATE_ISO_RX = /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/
const CPF_LABELED_RX = /\bcpf\b[^0-9]{0,12}([\d.\-\s]{11,18})/i

export function isValidCpfDigits(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (d.length !== 11) return false
  if (/^(\d)\1{10}$/.test(d)) return false
  const calc = (len) => {
    let sum = 0
    for (let i = 0; i < len; i += 1) sum += Number(d[i]) * (len + 1 - i)
    const rest = (sum * 10) % 11
    return rest === 10 ? 0 : rest
  }
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10])
}

export function extractEmailFromText(text) {
  const m = String(text || '').match(EMAIL_RX)
  return m ? m[0].trim().toLowerCase() : ''
}

export function extractDataNascFromText(text) {
  const raw = String(text || '')
  const iso = raw.match(DATE_ISO_RX)
  if (iso) {
    const y = Number(iso[1])
    const mo = Number(iso[2])
    const da = Number(iso[3])
    if (isPlausibleBirthDate(y, mo, da)) return `${iso[1]}-${iso[2]}-${iso[3]}`
  }
  const br = raw.match(DATE_BR_RX)
  if (br) {
    const da = Number(br[1])
    const mo = Number(br[2])
    const y = Number(br[3])
    if (isPlausibleBirthDate(y, mo, da)) {
      return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`
    }
  }
  return ''
}

function isPlausibleBirthDate(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  if (year < 1920 || year > 2015) return false
  const dt = new Date(Date.UTC(year, month - 1, day))
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
}

export function extractCpfFromText(text, { phoneDigits = '' } = {}) {
  const raw = String(text || '')
  const labeled = raw.match(CPF_LABELED_RX)
  if (labeled?.[1]) {
    const d = labeled[1].replace(/\D/g, '').slice(0, 11)
    if (isValidCpfDigits(d)) return d
  }
  const phone = String(phoneDigits || '').replace(/\D/g, '')
  const chunks = raw.match(/\d[\d.\-\s]{9,16}\d/g) || []
  for (const chunk of chunks) {
    const d = chunk.replace(/\D/g, '')
    if (d.length !== 11) continue
    if (phone && (d === phone || phone.endsWith(d) || d === phone.slice(-11))) continue
    if (isValidCpfDigits(d)) return d
  }
  return ''
}

/**
 * Junta a mensagem atual com falas recentes do lead (não usa o assistente).
 * @returns {{ cpf: string, email: string, dataNasc: string }}
 */
export function extractCadastroFieldsFromInbound(userMessage, historyMessages = [], opts = {}) {
  const maxTurns = Number.isFinite(opts.maxUserTurns) ? opts.maxUserTurns : 8
  const parts = []
  const hist = Array.isArray(historyMessages) ? historyMessages : []
  const users = hist.filter((m) => m?.role === 'user' || m?.role === 'lead')
  for (const m of users.slice(-maxTurns)) {
    const t = String(m?.content || '').trim()
    if (t) parts.push(t)
  }
  const current = String(userMessage || '').trim()
  if (current && !parts.includes(current)) parts.push(current)
  const blob = parts.join('\n')
  return {
    cpf: extractCpfFromText(blob, { phoneDigits: opts.phoneDigits }),
    email: extractEmailFromText(blob),
    dataNasc: extractDataNascFromText(blob),
  }
}

export function formatDataNascBr(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  return `${m[3]}/${m[2]}/${m[1]}`
}
