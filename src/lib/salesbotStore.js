/**
 * Cliente das execuções do Salesbot (Pesquisa de Curso).
 *
 * As execuções são gravadas em `salesbot_execucoes` pelo backend e
 * lidas via endpoint `GET /api/salesbot/executions` (que faz proxy
 * pro Supabase com o service key — assim o front não precisa
 * conhecer credencial).
 */

function mapRow(r) {
  const payload = r?.payload || {}
  return {
    id: r.id,
    timestamp: r.created_at,
    leadId: r.lead_id,
    cursoOriginal: r.curso_original,
    cursoCorrigido: r.curso_corrigido,
    cursoBusca: r.curso_busca,
    encontrado: !!r.encontrado,
    model: r.model,
    durationMs: r.duration_ms || 0,
    error: r.error,
    steps: payload.steps || [],
    usage: payload.usage || null,
    aiMeta: payload.aiMeta || null,
    rowCurso: payload.rowCurso || null,
    grauOriginal: payload.grauOriginal || null,
    nivel: payload.nivel || 'graduacao',
  }
}

export async function getAllSalesbotExecutions(limit = 200) {
  try {
    const res = await fetch(`/api/salesbot/executions?limit=${encodeURIComponent(limit)}`)
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.error('[SalesbotStore] fetch falhou:', res.status, err)
      return []
    }
    const rows = await res.json()
    if (!Array.isArray(rows)) return []
    return rows.map(mapRow)
  } catch (e) {
    console.error('[SalesbotStore] erro:', e.message)
    return []
  }
}

export async function runSalesbotForLead(leadId) {
  const res = await fetch('/api/salesbot/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId: Number(leadId) }),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok && !data.error, ...data }
}

/**
 * Gera embeddings dos cursos pós (text-embedding-3-small).
 * Lê todas as linhas de cursos_salesbot_pos_nome onde os dados já
 * foram populados via SQL e faz PATCH atualizando só a coluna
 * `embedding`. Demora ~30-60s pra 280+ cursos.
 */
export async function reindexPosEmbeddings() {
  const res = await fetch('/api/salesbot/reindex-pos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  const data = await res.json().catch(() => ({}))
  return { httpOk: res.ok, ...data }
}

