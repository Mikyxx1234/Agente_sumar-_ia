/**
 * Upload + vetorização de documentos para as tabelas RAG da Sumaré:
 * grad_info, grad_preco, pos_info, pos_preco.
 *
 * Cada linha das tabelas tem: id (bigint), content (text), metadata (jsonb),
 * embedding (vector 1536, text-embedding-3-small).
 *
 * Estratégia de chunking:
 *  - CSV / XLSX → 1 linha = 1 chunk (preserva semântica de planilha; ideal
 *    para grad_preco/pos_preco onde cada linha já é "curso → preço").
 *  - PDF / TXT / MD → chunking por tamanho (~1000 chars com overlap 100).
 *
 * Endpoint correlato:
 *   POST /api/ai/knowledge/upload   (multipart: file=<arquivo>, table=<grad_info|...>)
 *   POST /api/ai/knowledge/clear    ({ table })
 *   GET  /api/ai/knowledge/stats
 */

import { resolveModel } from './modelRegistry.js'

export const ALLOWED_TABLES = new Set(['grad_info', 'grad_preco', 'pos_info', 'pos_preco'])

const EMBED_BATCH = 50
const INSERT_BATCH = 200
const CHUNK_CHARS = 1000
const CHUNK_OVERLAP = 100
const MAX_CHUNKS_PER_UPLOAD = 5000

function getConfig(env) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_KEY não configurados')
  return { apiKey, url, key }
}

// ─────────────────────────────────────────────────────────────────────
// Extração de texto
// ─────────────────────────────────────────────────────────────────────

async function extractFromPdf(buffer) {
  // Import dinâmico — pdf-parse executa código no boot do módulo que tenta
  // ler um arquivo de teste; o import dinâmico isola o efeito colateral.
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js')
  const data = await pdfParse(buffer)
  return String(data.text || '')
}

function extractFromTxt(buffer) {
  return buffer.toString('utf8')
}

function parseCsvLine(line) {
  // Parser simples com suporte a aspas duplas.
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') inQuotes = false
      else cur += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',' || c === ';') { out.push(cur); cur = '' }
      else cur += c
    }
  }
  out.push(cur)
  return out.map((v) => v.trim())
}

function rowsFromCsv(buffer) {
  const text = buffer.toString('utf8').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = parseCsvLine(lines[0])
  const rows = lines.slice(1).map((l) => parseCsvLine(l))
  return { headers, rows }
}

async function rowsFromXlsx(buffer) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const ws = wb.worksheets[0]
  if (!ws) return { headers: [], rows: [] }
  const rows = []
  let headers = []
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = []
    row.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value
      if (v == null) values.push('')
      else if (typeof v === 'object' && 'text' in v) values.push(String(v.text || ''))
      else if (typeof v === 'object' && 'result' in v) values.push(String(v.result ?? ''))
      else if (v instanceof Date) values.push(v.toISOString().slice(0, 10))
      else values.push(String(v))
    })
    if (rowNumber === 1) headers = values
    else rows.push(values)
  })
  return { headers, rows }
}

function joinRowAsContent(headers, row) {
  const pairs = []
  for (let i = 0; i < row.length; i++) {
    const k = (headers[i] || `col${i + 1}`).trim()
    const v = (row[i] || '').toString().trim()
    if (k && v) pairs.push(`${k}: ${v}`)
  }
  return pairs.join(' | ')
}

// Divide texto longo em chunks com overlap. Quebra preferencialmente em
// limites de frase/parágrafo quando possível.
function chunkText(text, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const clean = String(text || '').replace(/\u0000/g, '').trim()
  if (!clean) return []
  const out = []
  let i = 0
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length)
    if (end < clean.length) {
      // tenta empurrar pro próximo ponto / quebra de parágrafo
      const slice = clean.slice(i, end + 200)
      const localBreak = slice.search(/(\n\n|\.\s|\?\s|\!\s)/)
      if (localBreak > size * 0.5 && localBreak < size + 200) {
        end = i + localBreak + 1
      }
    }
    const piece = clean.slice(i, end).trim()
    if (piece) out.push(piece)
    if (end >= clean.length) break
    i = Math.max(end - overlap, i + 1)
  }
  return out
}

/**
 * Produz a lista final de { content, metadata } prontos para embedar/inserir.
 * Retorna `null` se o formato for desconhecido / vazio.
 */
export async function buildChunks(buffer, filename, mimeType) {
  const name = String(filename || '').toLowerCase()
  const baseMeta = { source: filename || '(unnamed)', uploaded_at: new Date().toISOString() }

  if (name.endsWith('.csv') || /text\/csv|application\/csv/.test(mimeType || '')) {
    const { headers, rows } = rowsFromCsv(buffer)
    return rows
      .map((row, idx) => ({
        content: joinRowAsContent(headers, row),
        metadata: { ...baseMeta, kind: 'csv_row', row_index: idx + 1, total_rows: rows.length },
      }))
      .filter((x) => x.content.length > 0)
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xls') ||
      /spreadsheetml|ms-excel/.test(mimeType || '')) {
    const { headers, rows } = await rowsFromXlsx(buffer)
    return rows
      .map((row, idx) => ({
        content: joinRowAsContent(headers, row),
        metadata: { ...baseMeta, kind: 'xlsx_row', row_index: idx + 1, total_rows: rows.length },
      }))
      .filter((x) => x.content.length > 0)
  }

  if (name.endsWith('.pdf') || /application\/pdf/.test(mimeType || '')) {
    const text = await extractFromPdf(buffer)
    const parts = chunkText(text)
    return parts.map((p, idx) => ({
      content: p,
      metadata: { ...baseMeta, kind: 'pdf_chunk', chunk_index: idx + 1, total_chunks: parts.length },
    }))
  }

  // TXT / MD / fallback
  const text = extractFromTxt(buffer)
  const parts = chunkText(text)
  return parts.map((p, idx) => ({
    content: p,
    metadata: { ...baseMeta, kind: 'text_chunk', chunk_index: idx + 1, total_chunks: parts.length },
  }))
}

// ─────────────────────────────────────────────────────────────────────
// Embeddings (OpenAI) + insert (Supabase REST)
// ─────────────────────────────────────────────────────────────────────

async function embedBatch({ apiKey, model }, texts) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`OpenAI embeddings ${r.status}: ${t.slice(0, 200)}`)
  }
  const data = await r.json()
  return {
    vectors: (data.data || []).map((d) => d.embedding),
    usage: data.usage || null,
  }
}

async function insertRows({ url, key }, table, rows) {
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`Supabase INSERT ${table} ${r.status}: ${t.slice(0, 300)}`)
  }
}

// ─────────────────────────────────────────────────────────────────────
// API principal
// ─────────────────────────────────────────────────────────────────────

export async function uploadKnowledge(env, { table, buffer, filename, mimeType }) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Tabela inválida: ${table}. Use uma de: ${[...ALLOWED_TABLES].join(', ')}`)
  }
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Arquivo vazio ou ausente.')
  }

  const t0 = Date.now()
  const cfg = getConfig(env)
  const model = resolveModel(env, 'embeddings')

  const chunks = await buildChunks(buffer, filename, mimeType)
  if (!chunks || chunks.length === 0) {
    return { ok: true, table, inserted: 0, chunks: 0, durationMs: Date.now() - t0, message: 'Nenhum conteúdo extraído.' }
  }
  if (chunks.length > MAX_CHUNKS_PER_UPLOAD) {
    throw new Error(`Limite de chunks excedido (${chunks.length} > ${MAX_CHUNKS_PER_UPLOAD}). Quebre o arquivo em partes menores.`)
  }

  const usage = { prompt_tokens: 0, total_tokens: 0 }
  let inserted = 0
  let batches = 0

  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const slice = chunks.slice(i, i + EMBED_BATCH)
    const { vectors, usage: u } = await embedBatch(
      { apiKey: cfg.apiKey, model },
      slice.map((c) => c.content),
    )
    if (u) {
      usage.prompt_tokens += u.prompt_tokens || u.input_tokens || 0
      usage.total_tokens += u.total_tokens || 0
    }
    batches += 1

    const rows = slice.map((c, k) => ({
      content: c.content,
      metadata: c.metadata,
      embedding: vectors[k],
    }))

    for (let j = 0; j < rows.length; j += INSERT_BATCH) {
      await insertRows(cfg, table, rows.slice(j, j + INSERT_BATCH))
    }
    inserted += slice.length
  }

  return {
    ok: true,
    table,
    inserted,
    chunks: chunks.length,
    batches,
    durationMs: Date.now() - t0,
    usage,
    model,
    filename: filename || null,
  }
}

export async function clearKnowledgeTable(env, table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Tabela inválida: ${table}. Use uma de: ${[...ALLOWED_TABLES].join(', ')}`)
  }
  const { url, key } = getConfig(env)
  // PostgREST exige um filtro pra DELETE. id é bigint, então gte.0 cobre tudo.
  const r = await fetch(`${url}/rest/v1/${table}?id=gte.0`, {
    method: 'DELETE',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`Supabase DELETE ${table} ${r.status}: ${t.slice(0, 300)}`)
  }
  return { ok: true, table }
}

export async function knowledgeStats(env) {
  const { url, key } = getConfig(env)
  const out = {}
  for (const table of ALLOWED_TABLES) {
    const r = await fetch(`${url}/rest/v1/${table}?select=id`, {
      method: 'HEAD',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    })
    let count = null
    const cr = r.headers.get('content-range')
    if (cr) {
      const m = cr.match(/\/(\d+|\*)/)
      if (m) count = m[1] === '*' ? null : Number(m[1])
    }
    out[table] = { ok: r.ok, count, status: r.status }
  }
  return { ok: true, tables: out }
}
