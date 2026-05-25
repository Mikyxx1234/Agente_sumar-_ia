/**
 * Catálogo sumare_captacao_curso (Supabase) — mapeia nome do curso → codigo_original API.
 */

const CACHE_TTL_MS = 5 * 60 * 1000
/** @type {{ at: number, rows: object[]|null, table: string }|null} */
let cache = null

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
  if (/^[A-Z0-9_]{4,32}$/i.test(raw)) return raw.toUpperCase()

  const key = normalizeCursoKey(raw)
  if (!key) return ''

  const rows = await fetchAllCaptacaoCursos(env)
  if (!rows.length) return ''

  const matches = rows.filter((r) => normalizeCursoKey(r.curso_nome) === key)
  if (!matches.length) {
    const partial = rows.filter((r) => {
      const nk = normalizeCursoKey(r.curso_nome)
      return nk.includes(key) || key.includes(nk)
    })
    if (!partial.length) return ''
    partial.sort((a, b) => modalidadeRank(a.modalidade) - modalidadeRank(b.modalidade))
    return String(partial[0].codigo_original || '').trim().toUpperCase()
  }

  matches.sort((a, b) => modalidadeRank(a.modalidade) - modalidadeRank(b.modalidade))
  return String(matches[0].codigo_original || '').trim().toUpperCase()
}

export function invalidateCaptacaoCursoCache() {
  cache = null
}
