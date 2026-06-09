/**
 * Monta content + metadata para linhas RAG grad_grade_curricular.
 */

export function buildGradeCurricularContent(row, disciplinas) {
  const parts = [
    `curso: ${row.nome || row.id}`,
    `modalidade: ${row.modalidade || ''}`,
    row.codigo ? `codigo_api: ${row.codigo}` : null,
    disciplinas.length ? `total_disciplinas: ${disciplinas.length}` : null,
    row.url ? `url_pagina: ${row.url}` : null,
    row.fonte ? `fonte_dados: ${row.fonte}` : null,
  ].filter(Boolean)

  if (row.intro) parts.push(`intro: ${String(row.intro).slice(0, 400)}`)
  if (disciplinas.length) {
    parts.push(`grade_curricular: ${disciplinas.join(' | ')}`)
  }

  return parts.join(' | ')
}

export function buildGradeCurricularMetadata(row, disciplinas, pages) {
  return {
    kind: 'grade_curricular',
    curso_id: row.id,
    curso_nome: row.nome || row.id,
    modalidade: row.modalidade || '',
    codigo_api: row.codigo || '',
    url_pagina: row.url || '',
    fonte_dados: row.fonte || '',
    total_disciplinas: disciplinas.length,
    total_paginas: pages?.length || 0,
    ok: Boolean(disciplinas.length),
    disciplinas,
    pages: (pages || []).map((p) => ({
      pagina: p.pagina,
      disciplinas: p.disciplinas || [],
    })),
    grade_sync_at: new Date().toISOString(),
    source: 'scrape-grade-curricular-sumare',
  }
}
