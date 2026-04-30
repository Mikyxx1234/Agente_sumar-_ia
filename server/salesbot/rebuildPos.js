/**
 * Rebuild do catálogo `cursos_salesbot_pos` a partir de
 * `documents_precos` (a tabela que a IA principal já usa pra preços).
 *
 * Por que: o salesbot precisa que catálogo + IA principal estejam
 * sempre sincronizados. Quando o time atualiza preços via reindex
 * principal, basta rodar este endpoint pra refletir tudo na pós.
 *
 * NOTA SOBRE METADATA: a coluna na documents_precos é `metadata`
 * (jsonb) ou `Metadata` (text com JSON.stringify). A primeira versão
 * deste módulo só tratava jsonb e por isso retornava 0 linhas na
 * documents_precos real (que tinha o nome `Metadata` + string). Esta
 * versão é defensiva: tenta as duas grafias e desserializa string.
 */

function ensureConfig(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL/SUPABASE_KEY não configurados')
  return { url: url.replace(/\/$/, ''), key }
}

function parseTempoMeses(t) {
  const s = String(t || '').toLowerCase()
  const m = s.match(/(\d+)\s*(meses?|m\b)/i)
  if (m) return Number(m[1])
  const n = Number(s)
  return Number.isFinite(n) ? n : Infinity
}

function normalizeCursoKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleCase(s) {
  const small = new Set(['de', 'em', 'da', 'do', 'das', 'dos', 'e', 'a'])
  return String(s || '')
    .toLowerCase()
    .split(' ')
    .map((w, i) => {
      if (i > 0 && small.has(w)) return w
      if (!w) return w
      return w[0].toUpperCase() + w.slice(1)
    })
    .join(' ')
    .trim()
}

/**
 * Pega o objeto de metadata de uma linha, com tolerância às várias
 * formas em que ele pode estar gravado:
 *   - row.metadata (jsonb) → já é objeto
 *   - row.Metadata (text)  → string JSON pra parsear
 *   - row.metadata (text)  → idem
 */
function readMetadata(row) {
  const candidates = [row?.metadata, row?.Metadata, row?.METADATA]
  for (const c of candidates) {
    if (!c) continue
    if (typeof c === 'object') return c
    if (typeof c === 'string') {
      const trimmed = c.trim()
      if (!trimmed) continue
      try {
        return JSON.parse(trimmed)
      } catch {
        // Tenta tirar BOM e re-parsear.
        const clean = trimmed.replace(/^\uFEFF/, '')
        try {
          return JSON.parse(clean)
        } catch {}
      }
    }
  }
  return null
}

async function fetchDocumentsPrecos({ url, key }) {
  // PostgREST usa Range pra paginar quando passa do default. Pra
  // garantir que pega tudo, usamos limit/offset explícitos.
  const all = []
  const PAGE = 1000
  let from = 0
  for (let page = 0; page < 50; page += 1) {
    const path = `documents_precos?select=*&limit=${PAGE}&offset=${from}`
    const r = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error(`GET documents_precos ${r.status}: ${t.slice(0, 200)}`)
    }
    const rows = await r.json()
    if (!Array.isArray(rows) || rows.length === 0) break
    all.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return all
}

function isPos(metadata) {
  if (!metadata || typeof metadata !== 'object') return false
  const tipo = String(metadata.tipo || metadata.Tipo || metadata.TIPO || '').toLowerCase()
  if (!tipo) return false
  // sem acento pra empatar "pós-graduação", "pos-graduacao", "pos", etc.
  const noAcc = tipo.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return /\bp[oó]s/.test(tipo) || /\bpos/.test(noAcc)
}

async function truncateCursosPos({ url, key }) {
  const r = await fetch(`${url}/rest/v1/cursos_salesbot_pos?id=gte.0`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`DELETE cursos_salesbot_pos ${r.status}: ${t.slice(0, 200)}`)
  }
}

async function insertCursosPos({ url, key }, rows) {
  if (rows.length === 0) return
  const r = await fetch(`${url}/rest/v1/cursos_salesbot_pos`, {
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
    throw new Error(`POST cursos_salesbot_pos ${r.status}: ${t.slice(0, 300)}`)
  }
}

/**
 * Roda o rebuild completo. Auto-detecta o formato do metadata na
 * tabela source.
 */
export async function rebuildPosFromDocumentsPrecos(env, opts = {}) {
  const t0 = Date.now()
  const cfg = ensureConfig(env)
  const all = await fetchDocumentsPrecos(cfg)
  const totalDocsLidos = all.length

  // Auto-detecta a estrutura: quantos têm metadata parseável e quantos
  // têm tipo bate com pós. Útil pra debugar quando o filter falha.
  let comMetadataParseavel = 0
  const tiposVistos = new Map()

  const posDocs = []
  for (const d of all) {
    const meta = readMetadata(d)
    if (meta && typeof meta === 'object') {
      comMetadataParseavel += 1
      const tipo = String(meta.tipo || meta.Tipo || '').trim() || '(sem tipo)'
      tiposVistos.set(tipo, (tiposVistos.get(tipo) || 0) + 1)
      if (isPos(meta)) posDocs.push({ raw: d, meta })
    }
  }
  const totalPos = posDocs.length

  // Agrupa por curso, deduplica pacotes pela duração — quando aparece
  // a mesma duração com preços diferentes (caso típico: "à vista" vs
  // "no boleto"), mantém o de MENOR preço (proposta conservadora —
  // assim o lead vê o melhor preço possível e a duração real do curso
  // não duplica).
  const cursos = new Map()
  for (const { meta } of posDocs) {
    const cursoRaw = String(meta.curso || meta.Curso || '').trim()
    if (!cursoRaw) continue
    const tempo = String(meta.tempo || meta.Tempo || meta.duracao || '').trim()
    const valor = String(meta.valor || meta.Valor || meta.preco || meta['preço'] || '').trim()
    const modalidade = String(meta.modalidade || meta.Modalidade || 'EAD').trim() || 'EAD'
    if (!tempo || !valor) continue

    const key = normalizeCursoKey(cursoRaw)
    if (!cursos.has(key)) {
      cursos.set(key, {
        nome: titleCase(cursoRaw.replace(/\s+/g, ' ').trim()),
        modalidade,
        pacotesByMeses: new Map(),
      })
    }
    const c = cursos.get(key)
    const meses = parseTempoMeses(tempo)
    const precoNum = Number(
      String(valor)
        .replace(/[^\d,.-]/g, '')
        .replace('.', '')
        .replace(',', '.'),
    )
    const prev = c.pacotesByMeses.get(meses)
    if (
      !prev
      || (Number.isFinite(precoNum) && Number.isFinite(prev.precoNum) && precoNum < prev.precoNum)
    ) {
      c.pacotesByMeses.set(meses, { tempo, valor, precoNum, meses })
    }
  }

  const rows = []
  const exemplosUmPacote = []
  let comDois = 0
  let comUm = 0
  for (const c of cursos.values()) {
    const pacotes = [...c.pacotesByMeses.values()].sort((a, b) => a.meses - b.meses)
    const p1 = pacotes[0] || {}
    const p2 = pacotes[1] || {}
    rows.push({
      Curso: c.nome,
      modalidade: c.modalidade || 'EAD',
      duracao_1: p1.tempo || null,
      preco_1: p1.valor || null,
      duracao_2: p2.tempo || null,
      preco_2: p2.valor || null,
      contagem: String(pacotes.length || 0),
    })
    if (pacotes.length >= 2) comDois += 1
    else if (pacotes.length === 1) {
      comUm += 1
      if (exemplosUmPacote.length < 12) exemplosUmPacote.push(c.nome)
    }
  }

  // Se não pegou nada, devolve diagnóstico em vez de truncar.
  if (rows.length === 0) {
    return {
      ok: false,
      totalDocsLidos,
      comMetadataParseavel,
      totalPos: 0,
      cursosAgrupados: 0,
      tiposVistos: Object.fromEntries(
        [...tiposVistos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
      ),
      sampleRowKeys: all[0] ? Object.keys(all[0]) : [],
      sampleMetadata: all[0]
        ? typeof all[0].Metadata !== 'undefined'
          ? String(all[0].Metadata).slice(0, 300)
          : typeof all[0].metadata !== 'undefined'
            ? String(JSON.stringify(all[0].metadata)).slice(0, 300)
            : null
        : null,
      durationMs: Date.now() - t0,
      error: 'Nenhuma linha pós encontrada — confira tiposVistos e sampleMetadata acima.',
    }
  }

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      totalDocsLidos,
      comMetadataParseavel,
      totalPos,
      cursosAgrupados: rows.length,
      comDoisPacotes: comDois,
      comUmPacote: comUm,
      exemplosUmPacote,
      tiposVistos: Object.fromEntries([...tiposVistos.entries()].sort((a, b) => b[1] - a[1])),
      durationMs: Date.now() - t0,
    }
  }

  await truncateCursosPos(cfg)
  for (let i = 0; i < rows.length; i += 100) {
    await insertCursosPos(cfg, rows.slice(i, i + 100))
  }

  return {
    ok: true,
    totalDocsLidos,
    comMetadataParseavel,
    totalPos,
    cursosAgrupados: rows.length,
    comDoisPacotes: comDois,
    comUmPacote: comUm,
    exemplosUmPacote,
    durationMs: Date.now() - t0,
  }
}
