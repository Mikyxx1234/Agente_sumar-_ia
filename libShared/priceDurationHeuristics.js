/**
 * Perguntas sobre manutenção do valor/desconto até o fim do curso, reajuste
 * anual e valor total — resposta canônica institucional.
 */

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

/** Lead pergunta se valor/desconto vale até o final do curso ou sobre reajuste/total. */
export function messageAsksPriceUntilCourseEndInText(text) {
  const t = normalize(text)
  if (!t || t.length < 6) return false

  if (/\b(ate|at[eé])\s+o\s+(final|fim)\s+do\s+curso\b/i.test(t)) return true
  if (/\b(ate|at[eé])\s+o\s+(final|fim)\b/i.test(t) && /\b(curso|mensalidade|valor|desconto|preco|pre[cç]o)\b/i.test(t)) {
    return true
  }
  if (/\b(valor|preco|pre[cç]o|mensalidade|desconto)\b/i.test(t) && /\b(ate|at[eé]|durante|por todo|fixo|fixa)\b/i.test(t) && /\b(curso|final|fim|gradua)\b/i.test(t)) {
    return true
  }
  if (/\b(valor|preco|pre[cç]o)\s+(total|inteiro)\b/i.test(t) && /\b(curso|gradua)\b/i.test(t)) return true
  if (/\bquanto\b/i.test(t) && /\b(pagar|custar)\b/i.test(t) && /\b(total|inteiro|todo o curso|curso todo)\b/i.test(t)) {
    return true
  }
  if (/\breajuste\b/i.test(t) && /\b(mensalidade|anual|ano|curso|valor)\b/i.test(t)) return true
  if (/\b(mensalidade|valor|desconto)\b/i.test(t) && /\b(fixo|fixa|permanece|mantem|mant[eé]m)\b/i.test(t)) {
    return true
  }
  if (/\b(desconto|mensalidade)\b/i.test(t) && /\b(vale|mantem|mant[eé]m|continua)\b/i.test(t) && /\b(todo|toda|sempre|mes)\b/i.test(t)) {
    return true
  }

  return false
}

function recentMessagesBlob(historyMessages, limit = 10) {
  return (historyMessages || [])
    .slice(-limit)
    .map((m) => String(m.content || ''))
    .join('\n')
}

/** Histórico recente menciona preço/mensalidade — contextualiza pergunta curta. */
export function recentConversationMentionsPrice(historyMessages = []) {
  const blob = normalize(recentMessagesBlob(historyMessages))
  if (!blob) return false
  return (
    /\b(mensalidade|valor|preco|pre[cç]o|rs\s?\$|r\$)\b/i.test(blob) ||
    /\b\d{2,3}[,.]\d{2}\b/.test(blob)
  )
}

/**
 * Lead pergunta se o valor/desconto se mantém até o fim do curso ou sobre
 * reajuste / valor total.
 */
export function messageAsksPriceUntilCourseEnd(text, historyMessages = []) {
  if (messageAsksPriceUntilCourseEndInText(text)) return true
  const t = normalize(text)
  if (!t || t.length > 80) return false
  if (!recentConversationMentionsPrice(historyMessages)) return false
  if (/\b(ate|at[eé])\s+o\s+(final|fim)\b/i.test(t)) return true
  if (/^(e\s+)?(esse|este|o)\s+(valor|preco|pre[cç]o|desconto)\s*\??$/.test(t)) return true
  return false
}

/** Extrai valor monetário mencionado no histórico recente (ex.: R$ 237,00). */
export function extractMensalidadeFromHistory(historyMessages = []) {
  const msgs = [...(historyMessages || [])].reverse()
  for (const m of msgs) {
    const content = String(m.content || '')
    const br = content.match(/R\$\s*(\d{1,4}(?:[.,]\d{1,2})?)/i)
    if (br?.[1]) {
      const raw = br[1].replace('.', ',')
      return raw.includes(',') ? `R$ ${raw}` : `R$ ${raw},00`
    }
    const plain = content.match(/\bmensalidade\s+[eé]?\s*(\d{2,3}[,.]\d{2})\b/i)
    if (plain?.[1]) return `R$ ${plain[1].replace('.', ',')}`
    const vi = content.match(/\bvi\s+que\s+a\s+mensalidade\s+[eé]\s*(\d{2,3}[,.]\d{2})\b/i)
    if (vi?.[1]) return `R$ ${vi[1].replace('.', ',')}`
  }
  return null
}

/** Resposta canônica sobre desconto até o fim do curso e reajuste anual. */
export function buildPriceUntilCourseEndReply({ mensalidade } = {}) {
  const valor = String(mensalidade || '').trim()
  const intro = valor
    ? `As mensalidades do curso estão no valor de ${valor}.`
    : 'As mensalidades do curso seguem o valor promocional que informamos.'

  return (
    `${intro}\n\n` +
    'Esse desconto especial que estamos oferecendo será mantido até o final de seu curso, somente ocorre um pequeno reajuste de 8 à 12% ao ano!\n\n' +
    'Eu não consigo lhe passar o valor exato do curso inteiro por conta deste reajuste! Ele é feito com base na inflação vigente no momento do mesmo, e as mensalidades costumam ser alteradas de entre 20 à 40 reais ao ano.'
  )
}
