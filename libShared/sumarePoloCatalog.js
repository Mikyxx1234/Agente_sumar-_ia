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

export function buildPoloEscolhaMessage(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const lines = SUMARE_POLOS_EAD.map(
    (p, i) => `${i + 1}. *${p.nome}* — ${p.endereco}`,
  )
  return (
    `Obrigado${nameBit}! Recebemos seu formulário. ` +
    `Para seguir com a inscrição na Faculdade Sumaré, em qual *polo* você prefere estudar? ` +
    `Todos são EAD; o polo é o ponto de apoio presencial:\n\n` +
    `${lines.join('\n')}\n\n` +
    `Responda com o *número* (1 a 5) ou o *nome do polo* (ex.: Tatuapé).`
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
  return (
    `Perfeito${nameBit}! Polo *${polo.nome}* (${polo.endereco}) registrado. ` +
    `Estou gerando sua inscrição no sistema da Sumaré e em instantes envio o link do contrato por aqui.`
  )
}
