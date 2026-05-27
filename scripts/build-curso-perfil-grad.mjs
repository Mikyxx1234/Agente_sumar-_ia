#!/usr/bin/env node
/**
 * Gera data/curso-perfil-grad.json a partir das páginas sumaread.com.br (graduação EAD).
 * Uso: node scripts/build-curso-perfil-grad.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'data', 'curso-perfil-grad.json')

const SLUG_ALIASES = {
  'gestao-de-seguranca-privada': 'gestao-da-seguranca-privada',
  'recursos-humanos': 'gestao-de-recursos-humanos',
  gastronomia: 'gastronomia-ead',
  'superior-em-servico-social': 'servico-social',
}

function slugFromNome(nome) {
  let s = String(nome || '')
    .replace(/^Graduação\s*-\s*/i, '')
    .trim()
  const slug = s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return SLUG_ALIASES[slug] || slug
}

function decodeBasicEntities(html) {
  return String(html || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-z]+);/gi, (full, name) => {
      const map = {
        aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
        agrave: 'à', atilde: 'ã', acirc: 'â', ecirc: 'ê', ocirc: 'ô',
        ccedil: 'ç', Aacute: 'Á', Eacute: 'É', Ccedil: 'Ç', Atilde: 'Ã',
      }
      return map[name.toLowerCase()] || full
    })
}

function stripHtml(html) {
  return decodeBasicEntities(String(html || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sectionAfter(markers, html) {
  const text = stripHtml(html)
  for (const marker of markers) {
    const re = new RegExp(marker + '([\\s\\S]{0,1200}?)(?=Mercado de trabalho|Área de atuação|Consulte nossa grade|Por que escolher|$)', 'i')
    const m = text.match(re)
    if (m?.[1]) {
      const chunk = m[1].trim()
      if (chunk.length > 40) return chunk.slice(0, 600)
    }
  }
  const sobre = text.match(/Sobre o curso\s+([\s\S]{80,700}?)(?=Mercado de trabalho|Área de atuação)/i)
  if (sobre?.[1]) return sobre[1].trim().slice(0, 600)
  return null
}

function parseAreaAtuacao(html) {
  const text = stripHtml(html)
  const m = text.match(
    /[ÁA]rea de atua[cç][aã]o\s+([\s\S]{40,800}?)(?=Consulte nossa grade|Por que escolher|Semestre é igual|$)/i,
  )
  if (!m?.[1]) return null
  return m[1]
    .replace(/Semestre é igual.*/i, '')
    .replace(/\s*Ver Preço\s*$/i, '')
    .trim()
    .slice(0, 500)
}

function parseFuncoesFromMercado(html) {
  const text = stripHtml(html)
  const m = text.match(
    /Mercado de trabalho\s+([\s\S]{40,450}?)(?=[ÁA]rea de atua[cç][aã]o|Consulte nossa grade|$)/i,
  )
  return m?.[1]?.trim().slice(0, 400) || null
}

async function fetchPerfil(nome) {
  const slug = slugFromNome(nome)
  const url = `https://www.sumaread.com.br/cursos-graduacao-sumare/${slug}`
  const res = await fetch(url, { headers: { 'User-Agent': 'SumareAgentBuild/1.0' } })
  if (!res.ok) return { nome, slug, url, ok: false, status: res.status }
  const html = await res.text()
  const areaInteresse = sectionAfter(['Sobre o curso'], html)
  const areasTrabalho = parseAreaAtuacao(html)
  const funcoes = parseFuncoesFromMercado(html)
  return {
    nome: nome.replace(/^Graduação\s*-\s*/i, '').trim(),
    slug,
    url,
    ok: true,
    areaInteresse,
    areasTrabalho,
    funcoes,
  }
}

async function main() {
  const envPath = path.join(ROOT, '.env')
  if (!fs.existsSync(envPath)) {
    console.error('Crie .env com SUPABASE_URL e SUPABASE_KEY')
    process.exit(1)
  }
  const env = { ...process.env }
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!env[k]) env[k] = line.slice(i + 1)
  }
  const url = env.SUPABASE_URL.replace(/\/$/, '')
  const key = env.SUPABASE_KEY
  const res = await fetch(`${url}/rest/v1/grad_info?select=content&order=id.asc`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  const rows = await res.json()
  const names = []
  for (const row of rows) {
    const m = row.content?.match(/nome_curso:\s*([^|]+)/)
    if (m) names.push(m[1].trim().replace(/^Graduação\s*-\s*/i, '').trim())
  }
  const unique = [...new Set(names)]
  const out = []
  for (const nome of unique) {
    process.stdout.write(`… ${nome}\n`)
    const p = await fetchPerfil(nome)
    if (p.ok && (p.areaInteresse || p.areasTrabalho)) {
      out.push({
        nome: p.nome,
        areaInteresse: p.areaInteresse || undefined,
        areasTrabalho: p.areasTrabalho || undefined,
        funcoes: p.funcoes || undefined,
        fonte: p.url,
      })
    } else {
      console.warn(`  skip ${nome} (${p.status || 'sem conteúdo'})`)
    }
    await new Promise((r) => setTimeout(r, 350))
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8')
  console.log(`Wrote ${out.length} perfis → ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
