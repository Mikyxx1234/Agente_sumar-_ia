#!/usr/bin/env node
/**
 * Extrai a grade curricular ("O que você vai aprender") dos cursos de pós-graduação
 * publicados em https://mg.sumare.edu.br/pos-graduacao/{ead,hibrido}
 *
 * Fonte por página de curso: HTML server-rendered (.item-1 na seção "O que você vai aprender")
 *
 * Uso:
 *   node scripts/scrape-grade-curricular-pos-sumare.mjs --dry-run
 *   node scripts/scrape-grade-curricular-pos-sumare.mjs
 *   node scripts/scrape-grade-curricular-pos-sumare.mjs --only psicopedagogia
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'data')
const OUT_CSV = path.join(OUT_DIR, 'grade-curricular-pos-sumare.csv')
const OUT_RESUMO = path.join(OUT_DIR, 'grade-curricular-pos-sumare-resumo.csv')
const OUT_JSON = path.join(OUT_DIR, 'grade-curricular-pos-sumare.json')

const BASE = 'https://mg.sumare.edu.br'
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

const UA = 'Mozilla/5.0 SumarePosGradeScraper/1.0'

const LISTINGS = [
  { modalidade: 'EAD', path: '/pos-graduacao/ead' },
  { modalidade: 'Híbrido', path: '/pos-graduacao/hibrido' },
]

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

function slugFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean)
    return p[p.length - 1] || ''
  } catch {
    return ''
  }
}

function normalizeNomeFromH1(raw) {
  let s = stripHtml(raw)
  s = s.replace(/^pós-graduação\s+em\s+/i, '')
  s = s.replace(/^pos-graduacao\s+em\s+/i, '')
  return s.trim() || raw
}

async function loadCoursePagesFromListings() {
  const entries = []
  const seen = new Set()

  for (const { modalidade, path: listPath } of LISTINGS) {
    const res = await fetch(BASE + listPath, { headers: { 'User-Agent': UA } })
    if (!res.ok) {
      console.warn(`Listagem ${listPath} falhou: ${res.status}`)
      continue
    }
    const html = await res.text()
    const links = [
      ...new Set(
        [...html.matchAll(/href=["'](\/cursos\/pos-graduacao\/[^"']+)["']/gi)].map((m) => m[1]),
      ),
    ]
    for (const rel of links) {
      const url = rel.startsWith('http') ? rel : BASE + rel
      const key = url.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const id = slugFromUrl(url)
      entries.push({ id, nome: id.replace(/-/g, ' '), url, modalidade, nivel: 'pos' })
    }
  }

  entries.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR') || a.modalidade.localeCompare(b.modalidade))
  return entries
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

function extractNomeFromHtml(html, fallback) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  if (h1) return normalizeNomeFromH1(h1[1])
  return fallback
}

async function scrapeCoursePage(entry) {
  const res = await fetch(entry.url, { headers: { 'User-Agent': UA }, redirect: 'follow' })
  if (!res.ok) {
    return { ...entry, ok: false, status: res.status, codigo: '', intro: '', pages: [], fonte: 'erro_http' }
  }
  const html = await res.text()
  const nome = extractNomeFromHtml(html, entry.nome)
  const intro = extractIntroText(html)
  const pages = parseDisciplinesFromHtml(html)

  return {
    ...entry,
    nome,
    ok: pages.some((p) => p.disciplinas.length > 0),
    status: res.status,
    codigo: '',
    intro,
    pages,
    fonte: pages.length ? 'html' : 'vazio',
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
      'nivel',
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
            csvEscape(r.nivel),
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
          csvEscape(r.nivel),
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
      'nivel',
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
        csvEscape(r.nivel),
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
  console.log(DRY ? 'DRY-RUN — listando páginas de pós\n' : 'Extraindo grades curriculares (pós)...\n')
  const catalog = await loadCoursePagesFromListings()
  let targets = catalog
  if (ONLY?.size) {
    targets = catalog.filter(
      (c) =>
        ONLY.has(c.id.toLowerCase()) ||
        ONLY.has(slugFromUrl(c.url)) ||
        ONLY.has(c.nome.toLowerCase()),
    )
  }
  console.log(`Páginas de curso encontradas: ${targets.length}`)

  const results = []
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    console.log(`[${i + 1}/${targets.length}] ${t.modalidade} — ${t.id} → ${t.url}`)
    if (DRY) continue
    const r = await scrapeCoursePage(t)
    console.log(`  → ${r.nome} fonte=${r.fonte} disciplinas=${r.totalDisciplinas || 0} ok=${r.ok}`)
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
