#!/usr/bin/env node
/**
 * Remove linhas grad_info (grade curricular) com modalidade não ofertada oficialmente.
 *
 * Uso:
 *   node scripts/prune-stale-grade-rag.mjs --dry-run
 *   node scripts/prune-stale-grade-rag.mjs --apply
 */
import fs from 'node:fs'
import { fetchOfferedModalidadesByCourse } from '../server/sumareCaptacaoCursoStore.js'
import {
  courseKeyFromKnowledgeRow,
  modalidadeFromKnowledgeRow,
  lookupOfertaModalidades,
} from '../libShared/cursoOfertaFilter.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!env[k]) env[k] = line.slice(i + 1)
}

const DRY = !process.argv.includes('--apply')
const U = (env.SUPABASE_URL || '').replace(/\/$/, '')
const K = env.SUPABASE_KEY || ''
const H = { apikey: K, Authorization: `Bearer ${K}` }

async function main() {
  const map = await fetchOfferedModalidadesByCourse(env)
  const r = await fetch(
    `${U}/rest/v1/grad_info?select=id,content,metadata&metadata->>kind=eq.grade_curricular&limit=1000`,
    { headers: H },
  )
  const rows = await r.json()
  if (!Array.isArray(rows)) throw new Error('grad_info: resposta inválida')

  const stale = []
  for (const row of rows) {
    const wrapped = { content: row.content, metadata: row.metadata, id: row.id, source: 'grad_info' }
    const key = courseKeyFromKnowledgeRow(wrapped)
    const mod = modalidadeFromKnowledgeRow(wrapped)
    const oficiais = lookupOfertaModalidades(map, key)
    if (!oficiais?.size || !mod) continue
    if (!oficiais.has(mod)) stale.push({ id: row.id, key, mod, oficiais: [...oficiais] })
  }

  console.log(DRY ? 'DRY-RUN\n' : 'APPLY\n')
  console.log(`Linhas grade obsoletas: ${stale.length}`)
  for (const s of stale) {
    console.log(`  id=${s.id} ${s.key} modalidade=${s.mod} oferta=[${s.oficiais.join(', ')}]`)
  }

  if (DRY || !stale.length) return

  for (const s of stale) {
    const del = await fetch(`${U}/rest/v1/grad_info?id=eq.${s.id}`, { method: 'DELETE', headers: H })
    console.log(`DELETE id=${s.id} status=${del.status}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
