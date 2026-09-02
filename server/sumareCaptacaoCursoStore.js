/**
 * Catálogo sumare_captacao_curso (Supabase) — mapeia nome do curso → codigo_original API.
 */

import {
  normalizeModalidade,
  modalidadeToTurno,
  turnoFromCursoCodigo,
  modalidadeFromCursoCodigo,
} from '../libShared/cursoModalidade.js'

const CACHE_TTL_MS = 5 * 60 * 1000
/** @type {{ at: number, rows: object[]|null, table: string }|null} */
let cache = null
/** @type {{ at: number, map: Map<string, Set<string>> }|null} */
let ofertaCache = null

function getTable(env) {
  return env.SUMARE_CAPTACAO_CURSO_TABLE || 'sumare_captacao_curso'
}

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
  }
}

function normalizeCursoKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Tokens genéricos ignorados ao contar "tokens significativos" no partial match. */
const PARTIAL_MATCH_STOPWORDS = new Set([
  'de', 'do', 'da', 'dos', 'das', 'e', 'em', 'a', 'o', 'as', 'os', 'com', 'para',
  'curso', 'cursos', 'graduacao', 'pos', 'ead', 'presencial', 'semipresencial', 'gestao',
  'bacharelado', 'licenciatura', 'tecnologo', 'tecnologico', 'superior', 'mba', 'especializacao',
])

function significantCursoTokens(key) {
  return String(key || '')
    .split(' ')
    .filter((t) => t.length >= 3 && !PARTIAL_MATCH_STOPWORDS.has(t))
}

/**
 * Match parcial por tokens (palavras completas), não por substring dentro de
 * uma palavra. Evita que "psicopedagogia" case com "pedagogia" só porque uma
 * string contém a outra como substring — exige que os tokens do lado mais
 * curto apareçam como palavras inteiras no lado mais longo.
 */
function cursoKeysPartialMatch(a, b) {
  if (a === b) return false
  const tokensA = a.split(' ').filter(Boolean)
  const tokensB = b.split(' ').filter(Boolean)
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA]
  if (!shorter.length) return false
  const longerSet = new Set(longer)
  return shorter.every((t) => longerSet.has(t))
}

/**
 * Partial match seguro para resolução de oferta:
 * - query com 1 token significativo NÃO casa silenciosamente com oferta multi-token
 * - query com >=2 tokens: exige >=2 tokens significativos compartilhados
 */
function cursoKeysSafePartialMatch(queryKey, candidateKey) {
  if (!queryKey || !candidateKey || queryKey === candidateKey) return false
  const qSig = significantCursoTokens(queryKey)
  const cSig = significantCursoTokens(candidateKey)
  if (qSig.length === 0 || cSig.length === 0) return false
  // Consulta mono-token: só match exato (já tratado fora); nunca partial multi-token.
  if (qSig.length === 1) return false
  const cSet = new Set(cSig)
  let shared = 0
  for (const t of qSig) if (cSet.has(t)) shared += 1
  return shared >= 2
}

function modalidadeRank(mod) {
  const m = String(mod || '').toLowerCase()
  if (m === 'ead') return 0
  if (m.includes('semi')) return 1
  return 2
}

/**
 * @returns {Promise<object[]>}
 */
export async function fetchAllCaptacaoCursos(env = process.env) {
  const table = getTable(env)
  const now = Date.now()
  if (cache && cache.table === table && cache.rows && now - cache.at < CACHE_TTL_MS) {
    return cache.rows
  }

  const { url, key } = getSupabaseCfg(env)
  if (!url || !key) return []

  try {
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?select=codigo_original,codigo_base,curso_nome,modalidade,ativo&ativo=eq.true&order=curso_nome.asc&limit=500`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    )
    if (!res.ok) return []
    const rows = await res.json()
    const list = Array.isArray(rows) ? rows : []
    cache = { at: now, rows: list, table }
    return list
  } catch {
    return []
  }
}

/**
 * Resolve código API a partir do nome do curso (sum_Curso / card Kommo).
 * Prefere modalidade EAD quando há várias linhas para o mesmo curso.
 */
export async function resolveCursoCodigoFromDb(cursoInscricao, env = process.env) {
  const raw = String(cursoInscricao || '').trim()
  if (!raw) return ''
  // Código já pronto = token_token (ex.: GAST_EAD). Nome humano cai na busca.
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/i.test(raw)) return raw.toUpperCase()

  const key = normalizeCursoKey(raw)
  if (!key) return ''

  const rows = await fetchAllCaptacaoCursos(env)
  if (!rows.length) return ''

  const matches = rows.filter((r) => normalizeCursoKey(r.curso_nome) === key)
  if (!matches.length) {
    const partial = rows.filter((r) => cursoKeysSafePartialMatch(key, normalizeCursoKey(r.curso_nome)))
    if (!partial.length) return ''
    const uniqueNames = new Set(partial.map((r) => normalizeCursoKey(r.curso_nome)).filter(Boolean))
    if (uniqueNames.size !== 1) return ''
    partial.sort((a, b) => modalidadeRank(a.modalidade) - modalidadeRank(b.modalidade))
    return String(partial[0].codigo_original || '').trim().toUpperCase()
  }

  matches.sort((a, b) => modalidadeRank(a.modalidade) - modalidadeRank(b.modalidade))
  return String(matches[0].codigo_original || '').trim().toUpperCase()
}

/**
 * Modalidade(s) realmente ofertada(s) por curso, segundo a planilha oficial
 * (grad_preco/pos_preco). Fonte de verdade para escolher o código/turno certo:
 * Farmácia, por exemplo, só existe como Semipresencial.
 * @returns {Promise<Map<string, Set<string>>>} chaveNormalizada → Set(modalidade normalizada)
 */
export async function fetchOfferedModalidadesByCourse(env = process.env) {
  const now = Date.now()
  if (ofertaCache && now - ofertaCache.at < CACHE_TTL_MS) return ofertaCache.map

  const { url, key } = getSupabaseCfg(env)
  const map = new Map()
  if (!url || !key) {
    ofertaCache = { at: now, map }
    return map
  }

  const headers = { apikey: key, Authorization: `Bearer ${key}` }
  for (const table of ['grad_preco', 'pos_preco']) {
    try {
      const res = await fetch(
        `${url}/rest/v1/${table}?select=content,metadata&limit=1000`,
        { headers },
      )
      if (!res.ok) continue
      const rows = await res.json()
      for (const row of Array.isArray(rows) ? rows : []) {
        const chave =
          (String(row?.content || '').match(/chave:\s*([^|]+)/i)?.[1] || '').trim()
        if (!chave) continue
        const mod = normalizeModalidade(row?.metadata?.modalidade)
        if (!mod) continue
        const k = normalizeCursoKey(chave)
        if (!map.has(k)) map.set(k, new Set())
        map.get(k).add(mod)
      }
    } catch {
      // ignora falha de uma tabela; segue com o que tiver
    }
  }
  ofertaCache = { at: now, map }
  return map
}

/**
 * Busca as modalidades ofertadas de um curso no mapa oficial, tolerando pequenas
 * diferenças de nome entre catálogo e planilha (ex.: "Serviço Social" x
 * "Superior em Serviço Social"). Exato primeiro; depois inclusão mútua de chaves.
 * @returns {Set<string>|null}
 */
function lookupOfertaModalidades(map, key) {
  if (!map || !key) return null
  if (map.has(key)) return map.get(key)
  let best = null
  for (const [k, set] of map) {
    if (!k || k.length < 5) continue
    if (cursoKeysPartialMatch(k, key)) {
      if (!best || k.length > best.k.length) best = { k, set }
    }
  }
  return best?.set || null
}

/**
 * Resolve a oferta correta (código API + modalidade + turno) para a inscrição.
 * Prioriza a modalidade que a planilha oficial diz ser ofertada; cai no catálogo
 * quando não há info oficial. Retorna null quando não há código compatível.
 * @returns {Promise<{ codigo: string, modalidade: string, turno: string }|null>}
 */
export async function resolveCursoOfertaFromDb(cursoInscricao, env = process.env) {
  const raw = String(cursoInscricao || '').trim()
  if (!raw) return null

  // Código já pronto (ex.: FARM_SEMI / ECON_EAD): deriva modalidade/turno do sufixo.
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/i.test(raw)) {
    const codigo = raw.toUpperCase()
    const modalidade = modalidadeFromCursoCodigo(codigo)
    return { codigo, modalidade, turno: turnoFromCursoCodigo(codigo) }
  }

  const key = normalizeCursoKey(raw)
  if (!key) return null

  const rows = await fetchAllCaptacaoCursos(env)
  if (!rows.length) return null

  let candidatos = rows.filter((r) => normalizeCursoKey(r.curso_nome) === key)
  if (!candidatos.length) {
    const partial = rows.filter((r) => {
      const nk = normalizeCursoKey(r.curso_nome)
      return nk && cursoKeysSafePartialMatch(key, nk)
    })
    const uniqueNames = new Set(partial.map((r) => normalizeCursoKey(r.curso_nome)).filter(Boolean))
    // Resultado inequívoco: um único nome de curso (modalidades diferentes ok).
    if (uniqueNames.size === 1) candidatos = partial
  }
  if (!candidatos.length) return null

  // Modalidade ofertada oficialmente (fonte de verdade).
  const ofertaMap = await fetchOfferedModalidadesByCourse(env)
  const oficiais = lookupOfertaModalidades(ofertaMap, key)

  const pickByModalidade = (mod) =>
    candidatos.find((r) => normalizeModalidade(r.modalidade) === mod)

  let escolhido = null
  if (oficiais && oficiais.size) {
    // EAD funciona com turno EAD; prioriza EAD quando ofertado, senão Semipresencial.
    if (oficiais.has('EAD')) escolhido = pickByModalidade('EAD')
    if (!escolhido && oficiais.has('Semipresencial')) escolhido = pickByModalidade('Semipresencial')
  }

  // Sem info oficial: mantém preferência histórica (EAD), mas com turno coerente ao código.
  if (!escolhido) {
    candidatos.sort((a, b) => modalidadeRank(a.modalidade) - modalidadeRank(b.modalidade))
    escolhido = candidatos[0]
  }

  const codigo = String(escolhido?.codigo_original || '').trim().toUpperCase()
  if (!codigo) return null
  const modalidade = normalizeModalidade(escolhido?.modalidade) || modalidadeFromCursoCodigo(codigo)
  const turno = modalidadeToTurno(modalidade) || turnoFromCursoCodigo(codigo)
  return { codigo, modalidade, turno }
}

export function invalidateCaptacaoCursoCache() {
  cache = null
  ofertaCache = null
}
