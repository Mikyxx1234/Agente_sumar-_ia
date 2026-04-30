/**
 * Rebuild do catálogo `cursos_salesbot_pos` a partir de
 * `documents_precos` (a tabela que a IA principal já usa pra preços).
 *
 * Por que: o salesbot precisa que catálogo + IA principal estejam
 * sempre sincronizados. Quando o time atualiza preços via reindex
 * principal, basta rodar este endpoint pra refletir tudo na pós.
 *
 * Pipeline:
 *   1. SELECT * FROM documents_precos WHERE metadata->>tipo
 *      ILIKE '%pós-graduação%' OR ILIKE '%pos-graduacao%'
 *   2. Agrupa por curso (case-insensitive, trim).
 *   3. Para cada curso, pega no máximo 2 pacotes (menor duração no
 *      pacote 1, segunda menor no pacote 2). Se a fonte tiver dois
 *      pacotes com a MESMA duração mas preços diferentes, fica só
 *      o de menor preço (escolha conservadora — evita duplicar
 *      duracao_1=duracao_2 que era exatamente o bug que o usuário viu).
 *   4. TRUNCATE cursos_salesbot_pos (pra evitar resíduo).
 *   5. INSERT em batch.
 *   6. Retorna stats: total, com 1 pacote, com 2 pacotes, e exemplos
 *      de cursos que ficaram com duração única (auditoria).
 *
 * O endpoint NÃO toca em cursos_salesbot_pos_nome — após rebuild é
 * preciso rodar o /api/salesbot/reindex-pos pra refazer os
 * embeddings (a UI já tem botão pra isso).
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
  // Fallback: aceita "12" cru (assume meses).
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
  // Title Case: cada palavra maiúscula exceto "de", "em", "da" (a
  // menos que sejam a primeira palavra).
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

async function fetchDocumentsPrecosPos({ url, key }) {
  // Filtros possíveis pra pegar pós:
  //   metadata->>tipo ILIKE '%pós-graduação%'
  //   metadata->>tipo ILIKE '%pos-graduacao%'
  //   metadata->>tipo ILIKE '%pos%'
  // PostgREST aceita `metadata->>tipo=ilike.*pós*` (encode URL).
  // Mas como o user gerou o CSV com `tipo: "pós-graduação"`, vamos
  // bater por substring ignorando acento.
  const all = []
  const PAGE = 1000
  let from = 0
  for (let page = 0; page < 30; page += 1) {
    // PostgREST usa header Range pra paginar quando o resultado
    // ultrapassa o default. Vamos pedir tudo de uma vez (até PAGE).
    const path = `documents_precos?select=id,content,metadata&limit=${PAGE}&offset=${from}`
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
  const tipo = String(metadata.tipo || metadata.Tipo || '').toLowerCase()
  if (!tipo) return false
  // aceita "pós-graduação", "pos-graduacao", "pós graduação", "pos graduacao", "pos"
  return /\bp[oó]s/.test(tipo) || /\bpos[-_ ]?gradua/.test(tipo)
}

async function truncateCursosPos({ url, key }) {
  const r = await fetch(`${url}/rest/v1/cursos_salesbot_pos?id=gte.0`, {
    method: 'DELETE',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
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
 * Roda o rebuild completo.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   totalDocsLidos: number,
 *   totalPos: number,
 *   cursosAgrupados: number,
 *   comDoisPacotes: number,
 *   comUmPacote: number,
 *   exemplosUmPacote: string[],
 *   durationMs: number,
 *   error?: string
 * }>}
 */
export async function rebuildPosFromDocumentsPrecos(env) {
  const t0 = Date.now()
  const cfg = ensureConfig(env)
  const all = await fetchDocumentsPrecosPos(cfg)
  const totalDocsLidos = all.length

  const posDocs = all.filter((d) => isPos(d.metadata))
  const totalPos = posDocs.length

  // Agrupa por curso, depois desduplica pacotes pela duração (mantendo
  // o de menor preço se houver dois com mesma duração).
  const cursos = new Map()
  for (const d of posDocs) {
    const m = d.metadata || {}
    const cursoRaw = String(m.curso || m.Curso || '').trim()
    if (!cursoRaw) continue
    const key = normalizeCursoKey(cursoRaw)
    const tempo = String(m.tempo || m.Tempo || m.duracao || '').trim()
    const valor = String(m.valor || m.Valor || m.preco || m.preço || '').trim()
    const modalidade = String(m.modalidade || m.Modalidade || 'EAD').trim() || 'EAD'
    if (!tempo || !valor) continue

    if (!cursos.has(key)) {
      cursos.set(key, {
        nome: titleCase(cursoRaw.replace(/\s+/g, ' ').trim()),
        modalidade,
        pacotesByMeses: new Map(),
      })
    }
    const c = cursos.get(key)
    const meses = parseTempoMeses(tempo)
    const precoNum = Number(String(valor).replace(/[^\d,.-]/g, '').replace('.', '').replace(',', '.'))
    const prev = c.pacotesByMeses.get(meses)
    // Se já tem pacote com essa mesma duração, mantém o de menor preço
    // (ou o primeiro que apareceu, se preço inválido).
    if (!prev || (Number.isFinite(precoNum) && Number.isFinite(prev.precoNum) && precoNum < prev.precoNum)) {
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

  await truncateCursosPos(cfg)
  // INSERT em chunks de 100 pra não estourar limite do PostgREST.
  for (let i = 0; i < rows.length; i += 100) {
    await insertCursosPos(cfg, rows.slice(i, i + 100))
  }

  return {
    ok: true,
    totalDocsLidos,
    totalPos,
    cursosAgrupados: rows.length,
    comDoisPacotes: comDois,
    comUmPacote: comUm,
    exemplosUmPacote,
    durationMs: Date.now() - t0,
  }
}
