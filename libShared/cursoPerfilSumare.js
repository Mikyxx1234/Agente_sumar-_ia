/**
 * Perfis comerciais de graduação (área, mercado, funções) — fonte sumaread.com.br.
 * Anexados ao CONTEXT do RAG quando o curso tem entrada em data/curso-perfil-grad.json.
 */

import perfilGrad from '../data/curso-perfil-grad.json' with { type: 'json' }

/** @type {Record<string, { nome: string, areaInteresse?: string, areasTrabalho?: string, funcoes?: string }>|null} */
let cache = null

function loadPerfilMap() {
  if (cache) return cache
  const arr = Array.isArray(perfilGrad) ? perfilGrad : []
  /** @type {Record<string, typeof arr[0]>} */
  const map = {}
  for (const row of arr) {
    if (!row?.nome) continue
    for (const key of courseLookupKeys(row.nome)) {
      map[key] = row
    }
  }
  cache = map
  return cache
}

export function normalizeCourseLookupKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^graduacao\s*-\s*/i, '')
    .replace(/^gradua[cç][aã]o\s*-\s*/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function courseLookupKeys(nome) {
  const base = normalizeCourseLookupKey(nome)
  const keys = new Set([base])
  const short = base.replace(/\s+habilitacao\s+.*$/i, '').trim()
  if (short) keys.add(short)
  return [...keys]
}

export function extractCourseNameFromGradContent(content) {
  const m = String(content || '').match(/nome_curso:\s*([^|]+)/i)
  if (!m) return null
  return m[1].trim()
}

/**
 * @param {string} courseNameOrContent
 */
export function getCursoPerfil(courseNameOrContent) {
  const map = loadPerfilMap()
  const fromContent = extractCourseNameFromGradContent(courseNameOrContent)
  const raw = fromContent || String(courseNameOrContent || '').trim()
  if (!raw) return null
  for (const key of courseLookupKeys(raw)) {
    if (map[key]) return map[key]
  }
  return null
}

/**
 * @param {{ nome?: string, areaInteresse?: string, areasTrabalho?: string, funcoes?: string }} perfil
 */
export function formatPerfilBlockForRag(perfil) {
  if (!perfil) return null
  const lines = ['[PERFIL DO CURSO — use na resposta quando o lead pedir mais informações]']
  if (perfil.nome) lines.push(`curso: ${perfil.nome}`)
  if (perfil.areaInteresse) lines.push(`area_de_interesse: ${perfil.areaInteresse}`)
  if (perfil.areasTrabalho) lines.push(`areas_de_trabalho: ${perfil.areasTrabalho}`)
  if (perfil.funcoes) lines.push(`funcoes: ${perfil.funcoes}`)
  if (lines.length <= 1) return null
  return lines.join('\n')
}
