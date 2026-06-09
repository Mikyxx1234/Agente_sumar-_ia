#!/usr/bin/env node
/**
 * Extrai a grade curricular ("O que você vai aprender") dos cursos de graduação
 * publicados em https://sumare.edu.br/graduacao.html
 *
 * Fontes por página de curso:
 *   1) API https://sumare.edu.br/api-grade-cursos/cursoGrade?curso=<CODIGO>
 *   2) Fallback: HTML server-rendered (.item-1 dentro da seção "O que você vai aprender")
 *
 * Uso:
 *   node scripts/scrape-grade-curricular-sumare.mjs --dry-run
 *   node scripts/scrape-grade-curricular-sumare.mjs
 *   node scripts/scrape-grade-curricular-sumare.mjs --only pedagogia,administracao
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'data')
const OUT_CSV = path.join(OUT_DIR, 'grade-curricular-sumare.csv')
const OUT_RESUMO = path.join(OUT_DIR, 'grade-curricular-sumare-resumo.csv')
const OUT_JSON = path.join(OUT_DIR, 'grade-curricular-sumare.json')

const DRY = process.argv.includes('--dry-run')
const ONLY = (() => {
  const i = process.argv.indexOf('--only')
  if (i < 0) return null
  return new Set(
    String(process.argv[i + 1] || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
})()
const DELAY_MS = Number(process.argv.find((a, idx) => process.argv[idx - 1] === '--delay-ms') || 400)

const UA = 'Mozilla/5.0 SumareGradeScraper/1.0'
const CURSOS_JS_URL = 'https://sumare.edu.br/resources/assets/js/cursos-ead-presencial.js'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function decodeBasicEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

function stripHtml(html) {
  return decodeBasicEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function csvEscape(val) {
  const s = String(val ?? '')
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function modalidadeFromUrl(url) {
  const u = String(url || '').toLowerCase()
  if (u.includes('/semi/') || u.includes('/semipresencial/')) return 'Semipresencial'
  if (u.includes('/ead/')) return 'EAD'
  if (u.includes('/presencial/')) return 'Presencial'
  return 'Indefinido'
}

function slugFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean)
    return p[p.length - 1] || ''
  } catch {
    return ''
  }
}

const SEMI_SLUG_TO_CURSO_ID = {
  'superior-em-servico-social': 'servico-social',
  'letras-habilitacao-lingua-portuguesa': 'letras-lingua-portuguesa',
}

const CURSO_NOME_FALLBACK = {
  'gestao-hospitalar': 'Gestão Hospitalar',
}

/** Extrai entradas { nome, url, modalidade } do JS de catálogo do site. */
async function loadCoursePagesFromCatalog() {
  const res = await fetch(CURSOS_JS_URL, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Falha ao baixar catálogo: ${res.status}`)
  const js = await res.text()
  const cursoJs = js.match(/const CURSOS = (\[[\s\S]*?\n\])\s*\n/)?.[1] || js

  const byId = new Map()
  const blocks = cursoJs.split(/\n\s*\{\s*\n\s*id:\s*'/).slice(1)
  for (const block of blocks) {
    const idM = block.match(/^([^']+)'/)
    if (!idM) continue
    const id = idM[1]
    const nomeM = block.match(/nome:\s*'([^']+)'/)
    byId.set(id, { id, nome: nomeM?.[1] || id })
  }

  const entries = []
  const seen = new Set()

  function addEntry(id, nome, url) {
    if (!url?.includes('/graduacao/')) return
    if (url.endsWith('/graduacao/semipresencial')) return
    const key = url.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    entries.push({ id, nome, url, modalidade: modalidadeFromUrl(url) })
  }

  for (const block of blocks) {
    const idM = block.match(/^([^']+)'/)
    if (!idM) continue
    const id = idM[1]
    const nome = byId.get(id)?.nome || id
    for (const lm of block.matchAll(/linkSaibaMais:\s*'([^']+)'/g)) {
      addEntry(id, nome, lm[1].trim())
    }
  }

  const semiSection = js.slice(js.indexOf('SEMI_OVERRIDES'), js.indexOf('function upsertSemi'))
  for (const m of semiSection.matchAll(
    /linkSaibaMais:\s*\n?\s*'(https:\/\/sumare\.edu\.br\/graduacao\/semi\/[^']+)'/g,
  )) {
    const url = m[1].trim()
    const slug = slugFromUrl(url)
    const cursoId = SEMI_SLUG_TO_CURSO_ID[slug] || slug
    const nome = byId.get(cursoId)?.nome || CURSO_NOME_FALLBACK[cursoId] || slug.replace(/-/g, ' ')
    addEntry(cursoId, nome, url)
  }

  entries.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR') || a.modalidade.localeCompare(b.modalidade))
  return entries
}

function extractCursoCode(html) {
  const m =
    html.match(/id=["']curso["'][^>]*value=["']([^"']+)/i) ||
    html.match(/name=["']curso["'][^>]*value=["']([^"']+)/i) ||
    html.match(/value=["']([^"']+)["'][^>]*id=["']curso["']/i)
  return m?.[1]?.trim() || ''
}

function extractIntroText(html) {
  const idx = html.toLowerCase().indexOf('o que você vai aprender')
  if (idx < 0) return ''
  const chunk = html.slice(idx, idx + 2500)
  const p = chunk.match(/<p>([\s\S]*?)<\/p>/i)
  return p ? stripHtml(p[1]).slice(0, 500) : ''
}

function parseDisciplinesFromHtml(html) {
  const idx = html.toLowerCase().indexOf('o que você vai aprender')
  const slice = idx >= 0 ? html.slice(idx) : html
  const pages = []
  const pageBlocks = [...slice.matchAll(/<div class=['"]responsive-item['"][\s\S]*?(?=<div class=['"]responsive-item['"]|$)/gi)]
  const blocks = pageBlocks.length ? pageBlocks.map((m) => m[0]) : [slice]

  for (let p = 0; p < blocks.length; p++) {
    const items = [...blocks[p].matchAll(/<div class=["']item-1["']>\s*([\s\S]*?)\s*<\/div>/gi)]
      .map((m) => stripHtml(m[1]))
      .filter((t) => t && t.length > 1)
    if (items.length) pages.push({ pagina: p + 1, disciplinas: items })
  }

  if (!pages.length) {
    const flat = [...slice.matchAll(/<div class=["']item-1["']>\s*([\s\S]*?)\s*<\/div>/gi)]
      .map((m) => stripHtml(m[1]))
      .filter(Boolean)
    if (flat.length) pages.push({ pagina: 1, disciplinas: flat })
  }

  return pages
}

async function fetchGradeFromApi(codigo) {
  if (!codigo) return []
  const url = `https://sumare.edu.br/api-grade-cursos/cursoGrade?curso=${encodeURIComponent(codigo)}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) return []
    const data = await res.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) return []
    const keys = Object.keys(data).sort((a, b) => Number(a) - Number(b))
    if (!keys.length) return []
    return keys.map((k, i) => ({
      pagina: i + 1,
      disciplinas: (data[k] || []).map((d) => String(d.nomeDisciplina || d.nome || '').trim()).filter(Boolean),
    }))
  } catch {
    return []
  }
}

async function scrapeCoursePage(entry) {
  const res = await fetch(entry.url, { headers: { 'User-Agent': UA }, redirect: 'follow' })
  if (!res.ok) {
    return { ...entry, ok: false, status: res.status, codigo: '', intro: '', pages: [], fonte: 'erro_http' }
  }
  const html = await res.text()
  const codigo = extractCursoCode(html)
  const intro = extractIntroText(html)

  let pages = await fetchGradeFromApi(codigo)
  let fonte = pages.length ? 'api' : 'html'
  if (!pages.length) pages = parseDisciplinesFromHtml(html)

  return {
    ...entry,
    ok: pages.some((p) => p.disciplinas.length > 0),
    status: res.status,
    codigo,
    intro,
    pages,
    fonte,
    totalDisciplinas: pages.reduce((n, p) => n + p.disciplinas.length, 0),
  }
}

function toCsvRows(results) {
  const rows = []
  rows.push(
    [
      'curso_id',
      'curso_nome',
      'modalidade',
      'codigo_api',
      'url_pagina',
      'fonte_dados',
      'pagina_carrossel',
      'ordem_na_pagina',
      'ordem_global',
      'disciplina',
      'texto_intro_secao',
    ].join(','),
  )

  for (const r of results) {
    let global = 0
    for (const page of r.pages || []) {
      page.disciplinas.forEach((disc, idx) => {
        global++
        rows.push(
          [
            csvEscape(r.id),
            csvEscape(r.nome),
            csvEscape(r.modalidade),
            csvEscape(r.codigo),
            csvEscape(r.url),
            csvEscape(r.fonte),
            csvEscape(page.pagina),
            csvEscape(idx + 1),
            csvEscape(global),
            csvEscape(disc),
            csvEscape(global === 1 ? r.intro : ''),
          ].join(','),
        )
      })
    }
    if (!r.pages?.length) {
      rows.push(
        [
          csvEscape(r.id),
          csvEscape(r.nome),
          csvEscape(r.modalidade),
          csvEscape(r.codigo),
          csvEscape(r.url),
          csvEscape(r.fonte || 'vazio'),
          '',
          '',
          '',
          '',
          csvEscape(r.intro),
        ].join(','),
      )
    }
  }
  return rows.join('\n')
}

function toResumoCsv(results) {
  const rows = [
    [
      'curso_id',
      'curso_nome',
      'modalidade',
      'codigo_api',
      'url_pagina',
      'fonte_dados',
      'total_disciplinas',
      'total_paginas',
      'disciplinas_lista',
      'texto_intro_secao',
      'ok',
    ].join(','),
  ]
  for (const r of results) {
    const all = (r.pages || []).flatMap((p) => p.disciplinas)
    rows.push(
      [
        csvEscape(r.id),
        csvEscape(r.nome),
        csvEscape(r.modalidade),
        csvEscape(r.codigo),
        csvEscape(r.url),
        csvEscape(r.fonte),
        csvEscape(all.length),
        csvEscape((r.pages || []).length),
        csvEscape(all.join(' | ')),
        csvEscape(r.intro),
        csvEscape(r.ok ? 'sim' : 'nao'),
      ].join(','),
    )
  }
  return rows.join('\n')
}

async function main() {
  console.log(DRY ? 'DRY-RUN — listando páginas\n' : 'Extraindo grades curriculares...\n')
  const catalog = await loadCoursePagesFromCatalog()
  let targets = catalog
  if (ONLY?.size) {
    targets = catalog.filter(
      (c) => ONLY.has(c.id.toLowerCase()) || ONLY.has(slugFromUrl(c.url)) || ONLY.has(c.nome.toLowerCase()),
    )
  }
  console.log(`Páginas de curso encontradas: ${targets.length}`)

  const results = []
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    console.log(`[${i + 1}/${targets.length}] ${t.modalidade} — ${t.nome} → ${t.url}`)
    if (DRY) continue
    const r = await scrapeCoursePage(t)
    console.log(
      `  → codigo=${r.codigo || 'n/a'} fonte=${r.fonte} disciplinas=${r.totalDisciplinas || 0} ok=${r.ok}`,
    )
    results.push(r)
    if (i < targets.length - 1) await sleep(DELAY_MS)
  }

  if (DRY) {
    console.log('\n[dry-run] Nada gravado.')
    return
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT_CSV, `\ufeff${toCsvRows(results)}`, 'utf8')
  fs.writeFileSync(OUT_RESUMO, `\ufeff${toResumoCsv(results)}`, 'utf8')
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), 'utf8')

  const ok = results.filter((r) => r.ok).length
  const empty = results.length - ok
  console.log(`\nConcluído: ${ok} com disciplinas, ${empty} vazias/falha`)
  console.log(`CSV detalhado: ${OUT_CSV}`)
  console.log(`CSV resumo:    ${OUT_RESUMO}`)
  console.log(`JSON:          ${OUT_JSON}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
