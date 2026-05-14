/**
 * indexEstagioFromPdfs.mjs
 *
 * Lê todos os cursos de graduação da tabela `documents` no Supabase,
 * baixa o PDF de cada grade (link embutido no content), manda pra OpenAI
 * (gpt-4o-mini) identificar disciplinas obrigatórias de estágio
 * supervisionado, calcula totais LOCALMENTE (modelos erram aritmética
 * — caso real: somou 20+20+40+240+240+240 como 600, certo é 800), e
 * gera um arquivo SQL com os UPDATEs prontos para revisão no Supabase.
 *
 * NÃO aplica nada no banco. Você revisa o SQL e roda.
 *
 * Uso:
 *   node scripts/indexEstagioFromPdfs.mjs
 *
 * Saídas:
 *   server/ai/ATUALIZAR_ESTAGIO_AUTO.sql  ← UPDATEs prontos
 *   server/ai/ATUALIZAR_ESTAGIO_AUTO.log  ← relatório por curso
 */

import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf-8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)

const { SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY } = env
if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
  console.error('faltou SUPABASE_URL/SUPABASE_KEY/OPENAI_API_KEY no .env')
  process.exit(1)
}

const MODEL = 'gpt-4o-mini'
const CONCURRENCY = 4
const RETRY_ON_ERROR = 1
const OUT_SQL = 'server/ai/ATUALIZAR_ESTAGIO_AUTO.sql'
const OUT_LOG = 'server/ai/ATUALIZAR_ESTAGIO_AUTO.log'

// ── Helpers ───────────────────────────────────────────────────────────

function parseCourseName(content) {
  const m = content.match(/nome;info:\s*([^;"]+?)(?:;|$)/)
  if (!m) return null
  const raw = m[1].trim()
  const parts = raw.split(/\s*-\s*/)
  return { fullLabel: raw, name: parts[0]?.trim() || raw, modalidade: parts[1]?.trim() || null }
}

function parseGradeFileId(content) {
  // padrão: grade_do_curso:https://drive.google.com/file/d/<FILE_ID>/...
  const m = content.match(/grade_do_curso:\s*https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{10,})/i)
  return m?.[1] || null
}

function parseGrau(content) {
  // \S+ em vez de \w+ porque \w não casa com acentos em JS sem flag u —
  // sem isso "Tecnólogo" virava "Tecn" e cursos eram pulados como "não é graduação".
  const m = content.match(/grau_curso:\s*(\S+)/i)
  return m ? m[1].trim() : null
}

function isGraduacaoGrau(grau) {
  if (!grau) return false
  const g = grau.toLowerCase()
  return (
    g === 'bacharelado' ||
    g === 'tecnólogo' || g === 'tecnologo' ||
    g === 'licenciatura' ||
    g === 'tecnologia'
  )
}

async function fetchAllDocs() {
  const all = []
  let from = 0
  const pageSize = 100
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/documents?select=id,content&order=id.asc`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
        'Range-Unit': 'items',
      },
    })
    if (!r.ok) throw new Error(`supabase ${r.status}`)
    const data = await r.json()
    if (!Array.isArray(data) || data.length === 0) break
    all.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return all
}

async function downloadPdf(fileId) {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok) throw new Error(`drive ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (!buf.slice(0, 4).equals(Buffer.from('%PDF'))) {
    throw new Error(`não é PDF (header=${buf.slice(0, 8).toString('hex')}, ct=${r.headers.get('content-type')})`)
  }
  return buf
}

async function uploadOpenaiFile(pdfBuf, filename) {
  const form = new FormData()
  form.append('file', new Blob([pdfBuf], { type: 'application/pdf' }), filename)
  form.append('purpose', 'user_data')
  const r = await fetch('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  })
  if (!r.ok) throw new Error(`openai files ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return (await r.json()).id
}

async function deleteOpenaiFile(fileId) {
  try {
    await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    })
  } catch { /* ignore */ }
}

function buildPrompt(courseName) {
  return `Você está analisando a grade curricular do curso de ${courseName} de uma faculdade brasileira.

Liste APENAS as disciplinas obrigatórias cujo NOME contém a palavra "ESTÁGIO" (variações aceitas: "Estágio Supervisionado", "Estágio Curricular Supervisionado", "Estágio Obrigatório", "Estágio Profissional").

Para cada uma, registre o NOME EXATO como aparece na grade e a CARGA HORÁRIA em horas (número inteiro — para "240h" retorne 240, para "20h" retorne 20).

NÃO inclua: práticas, atividades de extensão, projetos integradores, tópicos especiais, projeto integrador transdisciplinar, atividades complementares, monografia/TCC, mesmo que tenham componente prático. Só conte disciplinas cujo nome contém EXPLICITAMENTE a palavra "ESTÁGIO".

Responda APENAS UM JSON válido (sem texto antes/depois, sem markdown, sem code fences) com este shape exato:

{
  "tem": boolean,
  "disciplinas": [
    { "nome": "string", "horas": number }
  ]
}

Onde:
- "tem" = true se há pelo menos 1 disciplina com "ESTÁGIO" no nome; false caso contrário
- "disciplinas" = array com cada disciplina identificada (vazio se tem=false)

NÃO inclua "quantidade" nem "carga_total_horas" — eu calculo isso localmente.`
}

async function analyzePdf(fileId, courseName) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', file: { file_id: fileId } },
            { type: 'text', text: buildPrompt(courseName) },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    }),
  })
  if (!r.ok) throw new Error(`openai chat ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  const content = data.choices?.[0]?.message?.content || ''
  const usage = data.usage || {}
  let parsed
  try { parsed = JSON.parse(content) } catch (e) {
    throw new Error(`json inválido: ${e.message}. content=${content.slice(0, 200)}`)
  }
  return { parsed, usage }
}

// ── Pipeline por curso ────────────────────────────────────────────────

async function processOne(doc, idx, total) {
  const course = parseCourseName(doc.content)
  const fileIdDrive = parseGradeFileId(doc.content)
  const grau = parseGrau(doc.content)
  const label = course?.fullLabel || `id=${doc.id}`

  const log = (msg) => console.log(`[${idx + 1}/${total}] ${label} — ${msg}`)

  if (!course) return { doc, status: 'skip', reason: 'sem nome detectado' }
  if (!fileIdDrive) return { doc, status: 'skip', reason: 'sem link de grade', course, grau }
  if (!isGraduacaoGrau(grau)) return { doc, status: 'skip', reason: `grau "${grau}" não é graduação`, course, grau }

  log(`baixando PDF (drive ${fileIdDrive})...`)
  let pdfBuf
  try {
    pdfBuf = await downloadPdf(fileIdDrive)
  } catch (e) {
    return { doc, status: 'fail_download', reason: e.message, course, grau, fileIdDrive }
  }

  let openaiFileId = null
  let attempts = 0
  while (attempts <= RETRY_ON_ERROR) {
    attempts++
    try {
      log(`upload PDF (${pdfBuf.length}B), tentativa ${attempts}...`)
      openaiFileId = await uploadOpenaiFile(pdfBuf, `grade_${doc.id}.pdf`)
      log(`analisando file_id=${openaiFileId}...`)
      const { parsed, usage } = await analyzePdf(openaiFileId, course.name)
      await deleteOpenaiFile(openaiFileId)

      const disciplinas = Array.isArray(parsed.disciplinas) ? parsed.disciplinas : []
      const cleanDisc = disciplinas
        .map((d) => ({
          nome: String(d?.nome || '').trim(),
          horas: Number.isFinite(Number(d?.horas)) ? Number(d.horas) : 0,
        }))
        .filter((d) => d.nome && d.horas > 0)
      const cargaTotal = cleanDisc.reduce((s, d) => s + d.horas, 0)
      const tem = cleanDisc.length > 0

      log(`OK — tem=${tem} qtd=${cleanDisc.length} total=${cargaTotal}h`)
      return {
        doc, status: 'ok', course, grau, fileIdDrive,
        estagio: { tem, quantidade: cleanDisc.length, carga_total_horas: cargaTotal, disciplinas: cleanDisc },
        usage,
      }
    } catch (e) {
      log(`erro tentativa ${attempts}: ${e.message}`)
      if (openaiFileId) await deleteOpenaiFile(openaiFileId)
      if (attempts > RETRY_ON_ERROR) {
        return { doc, status: 'fail_openai', reason: e.message, course, grau, fileIdDrive }
      }
    }
  }
}

async function runInBatches(items, fn, concurrency) {
  const results = []
  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i, items.length)
    }
  }))
  return results
}

// ── SQL generation ────────────────────────────────────────────────────

function sqlEscape(s) {
  return String(s).replace(/'/g, "''")
}

function buildEstagioDetalhe(disciplinas) {
  // ex: "Estágio Curricular Supervisionado em Farmácia I (20h), II (20h)..."
  return disciplinas
    .map((d) => `${d.nome} (${d.horas}h)`)
    .join(', ')
}

function buildSqlUpdate(r) {
  const { doc, course, estagio } = r
  const header = `-- ${course?.fullLabel || `id=${doc.id}`}${estagio.tem ? ` — TEM (${estagio.quantidade} disc., ${estagio.carga_total_horas}h)` : ' — SEM estágio'}`
  if (!estagio.tem) {
    return `${header}
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = ${doc.id};`
  }
  const detalhe = buildEstagioDetalhe(estagio.disciplinas)
  return `${header}
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', ${estagio.quantidade},
  'carga_total_horas', ${estagio.carga_total_horas},
  'detalhe', '${sqlEscape(detalhe)}'
), true)
where id = ${doc.id};`
}

// ── Main ──────────────────────────────────────────────────────────────

const t0 = Date.now()
console.log('▸ buscando docs no Supabase...')
const docs = await fetchAllDocs()
console.log(`▸ ${docs.length} docs carregados`)

console.log(`▸ processando em paralelo (concorrência ${CONCURRENCY})...\n`)
const results = await runInBatches(docs, processOne, CONCURRENCY)

// ── Relatório ──
const groups = { ok: [], skip: [], fail_download: [], fail_openai: [] }
for (const r of results) {
  if (r && groups[r.status]) groups[r.status].push(r)
}
const ok = groups.ok
const okTem = ok.filter((r) => r.estagio.tem)
const okSem = ok.filter((r) => !r.estagio.tem)

console.log('\n══════════════════════════════════════════════════════════════')
console.log(`Total processado: ${results.length}`)
console.log(`  ok (PDF analisado): ${ok.length}`)
console.log(`    com estágio: ${okTem.length}`)
console.log(`    sem estágio: ${okSem.length}`)
console.log(`  skip:           ${groups.skip.length}`)
console.log(`  fail_download:  ${groups.fail_download.length}`)
console.log(`  fail_openai:    ${groups.fail_openai.length}`)
console.log(`Tempo: ${Math.round((Date.now() - t0) / 1000)}s`)

// ── Escrever SQL ──
const lines = []
lines.push('-- ╔════════════════════════════════════════════════════════════════════╗')
lines.push('-- ║   ATUALIZAR_ESTAGIO_AUTO — gerado por scripts/indexEstagioFromPdfs ║')
lines.push('-- ║   Revise antes de rodar no Supabase SQL Editor.                    ║')
lines.push('-- ║   Cada bloco UPDATE atualiza metadata.estagio do curso pelo id.    ║')
lines.push('-- ╚════════════════════════════════════════════════════════════════════╝')
lines.push('')
lines.push(`-- Gerado em ${new Date().toISOString()}`)
lines.push(`-- Total cursos com estágio identificado: ${okTem.length}`)
lines.push(`-- Total cursos SEM estágio:               ${okSem.length}`)
lines.push(`-- Cursos pulados (sem link/grau): ${groups.skip.length}`)
lines.push(`-- Falhas (download/openai):       ${groups.fail_download.length + groups.fail_openai.length}`)
lines.push('')
lines.push('-- ═════════════ CURSOS COM ESTÁGIO ═════════════')
lines.push('')
for (const r of okTem) {
  lines.push(buildSqlUpdate(r))
  lines.push('')
}
lines.push('-- ═════════════ CURSOS SEM ESTÁGIO ═════════════')
lines.push('')
for (const r of okSem) {
  lines.push(buildSqlUpdate(r))
  lines.push('')
}
fs.mkdirSync(path.dirname(OUT_SQL), { recursive: true })
fs.writeFileSync(OUT_SQL, lines.join('\n'), 'utf-8')
console.log(`\n✓ SQL gerado em ${OUT_SQL}`)

// ── Log detalhado por curso ──
const logLines = []
logLines.push(`== Indexação de estágio — ${new Date().toISOString()} ==\n`)
for (const r of results) {
  if (!r) continue
  const label = r.course?.fullLabel || `id=${r.doc.id}`
  if (r.status === 'ok') {
    const detail = r.estagio.tem
      ? `TEM ${r.estagio.quantidade} disc, ${r.estagio.carga_total_horas}h — ${r.estagio.disciplinas.map((d) => `${d.nome} (${d.horas}h)`).join(' | ')}`
      : 'SEM estágio'
    logLines.push(`[OK]   id=${r.doc.id} ${label} → ${detail}`)
  } else if (r.status === 'skip') {
    logLines.push(`[SKIP] id=${r.doc.id} ${label} → ${r.reason}`)
  } else {
    logLines.push(`[FAIL_${r.status.split('_')[1].toUpperCase()}] id=${r.doc.id} ${label} → ${r.reason}`)
  }
}
fs.writeFileSync(OUT_LOG, logLines.join('\n'), 'utf-8')
console.log(`✓ Log detalhado em ${OUT_LOG}`)
console.log(`\n👉 PRÓXIMO PASSO: abra ${OUT_SQL}, revise rapidamente alguns blocos, e rode no SQL Editor do Supabase.`)
