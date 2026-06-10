/**
 * Filtra linhas RAG por modalidade realmente ofertada (grad_preco / pos_preco).
 */
import { normalizeModalidade } from './cursoModalidade.js'

export function normalizeCursoKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function lookupOfertaModalidades(map, key) {
  if (!map || !key) return null
  if (map.has(key)) return map.get(key)
  let best = null
  for (const [k, set] of map) {
    if (!k || k.length < 5) continue
    if (k.includes(key) || key.includes(k)) {
      if (!best || k.length > best.k.length) best = { k, set }
    }
  }
  return best?.set || null
}

export function courseKeyFromKnowledgeRow(row) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const fromMeta = meta.curso_nome || meta.curso || meta.nome_curso || meta.chave
  if (fromMeta) return normalizeCursoKey(fromMeta)

  const content = String(row?.content || '')
  for (const re of [
    /\bchave:\s*([^|]+)/i,
    /\bcurso:\s*([^|]+)/i,
    /\bnome_curso:\s*[^|]*-\s*([^|]+)/i,
    /\bnome_curso:\s*([^|]+)/i,
  ]) {
    const m = content.match(re)
    if (m?.[1]) {
      const k = normalizeCursoKey(m[1])
      if (k) return k
    }
  }
  return ''
}

export function modalidadeFromKnowledgeRow(row) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const fromMeta = normalizeModalidade(meta.modalidade)
  if (fromMeta) return fromMeta
  const m = String(row?.content || '').match(/\bmodalidade:\s*([^|]+)/i)
  return normalizeModalidade(m?.[1])
}

/**
 * @param {Array<object>} rows
 * @param {Map<string, Set<string>>} ofertaMap
 */
export function filterKnowledgeRowsByOfficialOffer(rows, ofertaMap) {
  if (!ofertaMap?.size) return { rows, removed: [] }
  const kept = []
  const removed = []
  for (const row of rows) {
    const key = courseKeyFromKnowledgeRow(row)
    const mod = modalidadeFromKnowledgeRow(row)
    if (!key || !mod) {
      kept.push(row)
      continue
    }
    const oficiais = lookupOfertaModalidades(ofertaMap, key)
    if (!oficiais?.size) {
      kept.push(row)
      continue
    }
    if (oficiais.has(mod)) kept.push(row)
    else removed.push({ id: row.id, source: row.source, key, mod, oficiais: [...oficiais] })
  }
  return { rows: kept, removed }
}

/**
 * Bloco de instrução interna com modalidades oficiais por curso citado no CONTEXT.
 */
export function buildOfficialOfferContextBlock(rows, ofertaMap, query = '') {
  if (!ofertaMap?.size) return ''
  const keys = new Set()
  for (const row of rows || []) {
    const k = courseKeyFromKnowledgeRow(row)
    if (k) keys.add(k)
  }
  const qKey = normalizeCursoKey(query)
  if (qKey.length >= 4) keys.add(qKey)

  const lines = []
  for (const key of keys) {
    const oficiais = lookupOfertaModalidades(ofertaMap, key)
    if (!oficiais?.size) continue
    const mods = [...oficiais].join(' e ')
    lines.push(
      `[OFERTA OFICIAL — ${key}: modalidade(s) disponível(is) = ${mods}. PROIBIDO citar outras modalidades para este curso.]`,
    )
  }
  if (!lines.length) return ''
  return ['OFERTA OFICIAL (planilha/site — prevalece sobre trechos antigos do RAG):', ...lines].join('\n')
}
