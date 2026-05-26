/**
 * Polos EAD Sumaré (SP) — escolha pós Form Sumar antes da API Captação.
 * Códigos `unidade` da API podem ser sobrescritos via SUMARE_CAPTACAO_POLO_UNIDADE_MAP (JSON).
 */

/** @typedef {{ id: string, nome: string, endereco: string, unidadeDefault: string, aliases: string[] }} SumarePoloEntry */

/** @type {SumarePoloEntry[]} */
export const SUMARE_POLOS_EAD = [
  {
    id: 'sao_miguel',
    nome: 'São Miguel',
    endereco: 'Rua Bernardo Bellotto, 8',
    unidadeDefault: 'ED_SP_P1',
    aliases: ['sao miguel', 'são miguel', 'bernardo bellotto'],
  },
  {
    id: 'barra_funda',
    nome: 'Barra Funda',
    endereco: 'Av. Marquês de São Vicente, 405 - Loja 5',
    unidadeDefault: 'ED_SP_P2',
    aliases: ['barra funda', 'marques de sao vicente', 'marquês de são vicente'],
  },
  {
    id: 'tatuape',
    nome: 'Tatuapé',
    endereco: 'Rua Martins Soares, 135',
    unidadeDefault: 'ED_SP_P3',
    aliases: ['tatuape', 'tatuapé', 'martins soares'],
  },
  {
    id: 'santana',
    nome: 'Santana',
    endereco: 'Rua Dr. Olavo Egídio, 14',
    unidadeDefault: 'ED_SP_P4',
    aliases: ['santana', 'olavo egidio', 'olavo egídio'],
  },
  {
    id: 'pinheiros',
    nome: 'Pinheiros',
    endereco: 'Rua Amélia de Noronha, 130',
    unidadeDefault: 'ED_SP_P5',
    aliases: ['pinheiros', 'amelia de noronha', 'amélia de noronha'],
  },
]

function normalizePoloText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parsePoloUnidadeMapEnv(env) {
  const raw = String(env?.SUMARE_CAPTACAO_POLO_UNIDADE_MAP || '').trim()
  if (!raw) return null
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    const map = new Map()
    for (const [k, v] of Object.entries(obj)) {
      const code = String(v || '').trim().toUpperCase()
      if (code) map.set(String(k).trim().toLowerCase(), code)
    }
    return map.size ? map : null
  } catch {
    return null
  }
}

export function resolvePoloUnidadeCode(poloId, env = process.env) {
  const id = String(poloId || '').trim().toLowerCase()
  const fromEnv = parsePoloUnidadeMapEnv(env)
  if (fromEnv?.has(id)) return fromEnv.get(id)
  const entry = SUMARE_POLOS_EAD.find((p) => p.id === id)
  return entry?.unidadeDefault || String(env?.SUMARE_CAPTACAO_UNIDADE_DEFAULT || 'ED_SP_P5').trim()
}

/**
 * Identifica polo a partir da mensagem do lead (número 1-5 ou nome).
 * @returns {SumarePoloEntry|null}
 */
export function matchPoloFromUserMessage(text) {
  const t = normalizePoloText(text)
  if (!t) return null

  const numMatch = t.match(/^\s*([1-5])\s*$/) || t.match(/\bop[cç][aã]o\s*([1-5])\b/)
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1
    if (idx >= 0 && idx < SUMARE_POLOS_EAD.length) return SUMARE_POLOS_EAD[idx]
  }

  for (const polo of SUMARE_POLOS_EAD) {
    if (t === normalizePoloText(polo.nome)) return polo
    for (const alias of polo.aliases) {
      if (t.includes(alias) || alias.includes(t)) return polo
    }
    if (t.includes(normalizePoloText(polo.nome))) return polo
  }
  return null
}

/**
 * Tenta resolver polo já preenchido no card Kommo (polo_inscricao / unidade).
 */
export function resolvePoloFromKommoSnapshot(snapshot, env = process.env) {
  if (!snapshot || typeof snapshot !== 'object') return null

  const unidadeRaw = String(snapshot.unidade || '').trim().toUpperCase()
  if (/^ED_SP_P\d+$/i.test(unidadeRaw)) {
    const byCode = SUMARE_POLOS_EAD.find((p) => resolvePoloUnidadeCode(p.id, env) === unidadeRaw)
    if (byCode) return { polo: byCode, unidade: unidadeRaw, source: 'kommo_unidade' }
  }

  const poloText = String(snapshot.polo_inscricao || snapshot.poloInscricao || '').trim()
  if (poloText) {
    const matched = matchPoloFromUserMessage(poloText)
    if (matched) {
      return {
        polo: matched,
        unidade: resolvePoloUnidadeCode(matched.id, env),
        source: 'kommo_polo_inscricao',
      }
    }
  }
  return null
}

/** Lista numerada dos 5 polos EAD (cadastro Sumaré). */
export function formatPoloListaNumerada() {
  return SUMARE_POLOS_EAD.map((p, i) => `${i + 1}. *${p.nome}* — ${p.endereco}`).join('\n')
}

/** Assistente acabou de pedir escolha de polo (lista 1–5) antes do Form Sumar. */
export function assistantAskedPoloPreFormChoice(text) {
  const a = String(text || '')
    .replace(/\s-\s+EX-\d{6}-\d{4}-\d{3}(-[a-f0-9]+)?\s*$/i, '')
    .toLowerCase()
  if (!a) return false
  if (/\b(em qual|qual)\b[\s\S]{0,50}\bpolo\b/i.test(a)) return true
  if (/\bsomente\b[\s\S]{0,40}\bestes polos\b/i.test(a)) return true
  if (/\bresponda com o\b[\s\S]{0,30}\b(n[uú]mero|nome do polo)\b/i.test(a)) return true
  if (/1\.\s*\*?s[aã]o miguel/i.test(a) && /tatuap[eé]/i.test(a)) return true
  return false
}

/** Antes do formulário: pergunta polo e limita às 5 unidades cadastradas. */
export function buildPoloEscolhaPreFormMessage(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Perfeito${nameBit}! Para seguir com sua inscrição na Faculdade Sumaré, primeiro preciso saber em qual *polo* ` +
    `você prefere se cadastrar. Todos os cursos são EAD; o polo é o ponto de apoio presencial.\n\n` +
    `Por este canal oferecemos *somente* estes polos:\n\n` +
    `${formatPoloListaNumerada()}\n\n` +
    `Responda com o *número* (1 a 5) ou o *nome do polo* (ex.: Pinheiros). ` +
    `Assim que confirmar, envio o formulário de dados básicos aqui no WhatsApp.`
  )
}

/** Pós-formulário (legado): ainda aguardando polo antes da captação. */
export function buildPoloEscolhaMessage(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Obrigado${nameBit}! Recebemos seu formulário. ` +
    `Para seguir com a inscrição na Faculdade Sumaré, em qual *polo* você prefere estudar?\n\n` +
    `${formatPoloListaNumerada()}\n\n` +
    `Responda com o *número* (1 a 5) ou o *nome do polo* (ex.: Tatuapé).`
  )
}

/** Lead pediu cidade/polo fora dos 5 cadastrados neste WhatsApp. */
export function messageMentionsUnlistedPoloLocation(text) {
  const t = normalizePoloText(text)
  if (!t || t.length < 4) return false
  if (matchPoloFromUserMessage(text)) return false
  // Polo do card Kommo (ex.: Santo Amaro) fora dos 5 EAD deste WhatsApp
  if (/\bsanto\s+amaro\b/.test(t)) return true
  if (/\b(outr[oa]s?\s+(cidade|polo|unidade|campus|local|regi[aã]o)|outro\s+polo|outra\s+cidade)\b/i.test(t)) {
    return true
  }
  if (/\b(s[oó]\s+atend|n[aã]o\s+tem|n[aã]o\s+oferece|fora\s+dessa|interior|outro\s+estado)\b/i.test(t)) {
    return true
  }
  return false
}

export function buildPoloOutroLocalidadeReply() {
  return (
    `Por este número de WhatsApp da Faculdade Sumaré oferecemos inscrição apenas nos *5 polos* listados abaixo:\n\n` +
    `${formatPoloListaNumerada()}\n\n` +
    `Se quiser seguir por aqui, responda com o *número* (1 a 5) ou o *nome* de um desses polos. ` +
    `Para outras localidades, nossa central pode orientar por outros canais de atendimento.`
  )
}

export function buildPoloConfirmacaoInvalidaReply() {
  return (
    'Não consegui identificar o polo. Por favor, responda com o número de 1 a 5 ou o nome do polo:\n\n' +
    SUMARE_POLOS_EAD.map((p, i) => `${i + 1}. ${p.nome}`).join('\n')
  )
}

export function buildPoloEscolhidoAckReply(polo, opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const afterForm = Boolean(opts.afterForm)
  if (afterForm) {
    return (
      `Perfeito${nameBit}! Polo *${polo.nome}* (${polo.endereco}) registrado. ` +
      `Estou gerando sua inscrição no sistema da Sumaré e em instantes envio o *link para você visualizar e aceitar o contrato* por aqui.`
    )
  }
  return (
    `Perfeito${nameBit}! Polo *${polo.nome}* (${polo.endereco}) registrado. ` +
    `Acabei de enviar o formulário de dados básicos aqui no WhatsApp — preencha e envie para continuarmos sua inscrição.`
  )
}
