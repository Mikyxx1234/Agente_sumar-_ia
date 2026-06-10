#!/usr/bin/env node
/**
 * Ingere grades curriculares de pós-graduação no RAG (pos_info).
 *
 * Fonte: data/grade-curricular-pos-sumare.json (gerado por scrape-grade-curricular-pos-sumare.mjs)
 *
 * Uso:
 *   node scripts/register-grade-curricular-pos-rag.mjs --dry-run
 *   node scripts/register-grade-curricular-pos-rag.mjs
 *   node scripts/register-grade-curricular-pos-rag.mjs --only psicopedagogia
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveModel } from '../server/ai/modelRegistry.js'
import {
  buildGradeCurricularContent,
  buildGradeCurricularMetadata,
} from '../libShared/gradeCurricularContent.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GRADE_JSON = path.join(__dirname, '../data/grade-curricular-pos-sumare.json')
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

const ID_BASE = 80001
const TABLE = 'pos_info'

const env = { ...process.env }
for (const line of fs.readFileSync(path.join(__dirname, '../.env'), 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const U = (env.SUPABASE_URL || '').replace(/\/$/, '')
const K = env.SUPABASE_KEY || ''
const H = { apikey: K, Authorization: `Bearer ${K}` }

if (!U || !K) {
  console.error('SUPABASE_URL e SUPABASE_KEY são obrigatórios.')
  process.exit(1)
}

async function embedBatch(texts) {
  const model = resolveModel(env, 'embeddings')
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, input: texts }),
  })
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  return data.data.sort((a, b) => a.index - b.index).map((x) => x.embedding)
}

function stableId(row) {
  const slug = `${row.id}::${row.modalidade}::${row.url || ''}`.toLowerCase()
  let h = 5381
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) >>> 0
  return ID_BASE + (h % 8999)
}

async function findExisting(cursoId, modalidade) {
  const q = `${U}/rest/v1/${TABLE}?select=id,metadata&metadata->>curso_id=eq.${encodeURIComponent(cursoId)}&metadata->>modalidade=eq.${encodeURIComponent(modalidade)}&metadata->>kind=eq.grade_curricular&limit=1`
  const r = await fetch(q, { headers: H })
  if (!r.ok) return null
  const rows = await r.json()
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

async function upsertRow(payload) {
  const existing = await findExisting(payload.metadata.curso_id, payload.metadata.modalidade)
  const id = existing?.id || payload.id

  if (DRY) {
    console.log(
      `[dry-run] ${existing ? 'PATCH' : 'INSERT'} id=${id} ${payload.metadata.curso_nome} (${payload.metadata.modalidade}) disc=${payload.metadata.total_disciplinas}`,
    )
    return { ok: true, id, dry: true }
  }

  const body = { ...payload, id }
  const url = existing ? `${U}/rest/v1/${TABLE}?id=eq.${id}` : `${U}/rest/v1/${TABLE}`
  const r = await fetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 300)}`)
  return { ok: true, id, action: existing ? 'patch' : 'insert' }
}

async function main() {
  if (!fs.existsSync(GRADE_JSON)) {
    console.error(`Arquivo não encontrado: ${GRADE_JSON}`)
    console.error('Rode: node scripts/scrape-grade-curricular-pos-sumare.mjs')
    process.exit(1)
  }

  let rows = JSON.parse(fs.readFileSync(GRADE_JSON, 'utf8'))
  if (ONLY?.size) {
    rows = rows.filter(
      (r) =>
        ONLY.has(String(r.id || '').toLowerCase()) ||
        ONLY.has(String(r.nome || '').toLowerCase()),
    )
  }

  const withGrade = rows.filter((r) => (r.pages || []).some((p) => (p.disciplinas || []).length))
  const empty = rows.length - withGrade.length
  console.log(DRY ? 'DRY-RUN\n' : 'Ingestão RAG pos_info (grade curricular)\n')
  console.log(`Total JSON: ${rows.length} | com disciplinas: ${withGrade.length} | vazias: ${empty}`)

  const BATCH = 40
  let ok = 0
  let skip = 0

  for (let i = 0; i < withGrade.length; i += BATCH) {
    const batch = withGrade.slice(i, i + BATCH)
    const payloads = batch.map((row) => {
      const disciplinas = row.pages.flatMap((p) => p.disciplinas || []).filter(Boolean)
      const rowWithNivel = { ...row, nivel: 'pos' }
      const content = buildGradeCurricularContent(rowWithNivel, disciplinas)
      const metadata = buildGradeCurricularMetadata(rowWithNivel, disciplinas, row.pages)
      return {
        id: stableId(row),
        content,
        metadata,
        _row: row,
      }
    })

    const embeddings = DRY ? [] : await embedBatch(payloads.map((p) => p.content))

    for (let j = 0; j < payloads.length; j++) {
      const p = payloads[j]
      if (!p.metadata.total_disciplinas) {
        skip++
        continue
      }
      const res = await upsertRow({
        id: p.id,
        content: p.content,
        metadata: p.metadata,
        embedding: embeddings[j] || undefined,
      })
      if (res.ok) ok++
      else console.error('Falha:', p._row.nome, p._row.modalidade)
    }
    console.log(`Lote ${Math.floor(i / BATCH) + 1}: ${Math.min(i + BATCH, withGrade.length)}/${withGrade.length}`)
  }

  console.log(`\nConcluído: ${ok} upserts, ${skip} ignoradas`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
