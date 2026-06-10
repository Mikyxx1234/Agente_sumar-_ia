/**
 * Formatação de linhas RAG (metadata → texto auxiliar pro LLM).
 * Compartilhado entre servidor (`server/ai/knowledgeSearch.js`) e
 * `server/ai/toolExecutorsServer.js` (legado `match_documents_*`).
 */

import { extractCourseNameFromGradContent, formatPerfilBlockForRag, getCursoPerfil } from './cursoPerfilSumare.js'

export function extractGradeLink(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const raw =
    metadata.grade_do_curso ||
    metadata.grade_curso ||
    metadata.link_grade ||
    metadata.gradeCurricular ||
    null
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) return null
  return s
}

export function extractEstagioInfo(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = metadata.estagio
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.tem !== 'boolean') return null
  const out = { tem: raw.tem }
  if (raw.tem === true) {
    if (Number.isFinite(Number(raw.quantidade))) out.quantidade = Number(raw.quantidade)
    if (Number.isFinite(Number(raw.carga_total_horas))) out.carga_total_horas = Number(raw.carga_total_horas)
    if (typeof raw.detalhe === 'string' && raw.detalhe.trim()) out.detalhe = raw.detalhe.trim()
    if (typeof raw.observacao === 'string' && raw.observacao.trim()) out.observacao = raw.observacao.trim()
  }
  return out
}

export function formatEstagioMarker(info) {
  if (!info) return null
  if (info.tem === false) {
    return 'ESTAGIO: NAO — nao ha disciplina de estagio supervisionado obrigatorio neste curso'
  }
  const partes = []
  if (info.quantidade != null) partes.push(`${info.quantidade} disciplina${info.quantidade === 1 ? '' : 's'} obrigatoria${info.quantidade === 1 ? '' : 's'}`)
  if (info.carga_total_horas != null) partes.push(`${info.carga_total_horas}h totais`)
  const head = partes.length > 0 ? partes.join(', ') : 'estagio supervisionado obrigatorio'
  let texto = `ESTAGIO: SIM — ${head}`
  if (info.detalhe) texto += `. ${info.detalhe}`
  if (info.observacao) texto += ` (${info.observacao})`
  return texto
}

export function deepFindKeys(obj, targets, found = {}, depth = 0) {
  if (!obj || depth > 6) return found
  if (typeof obj === 'string') {
    const trimmed = obj.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return deepFindKeys(JSON.parse(trimmed), targets, found, depth + 1)
      } catch { /* ignore */ }
    }
    return found
  }
  if (Array.isArray(obj)) {
    for (const item of obj) deepFindKeys(item, targets, found, depth + 1)
    return found
  }
  if (typeof obj !== 'object') return found
  for (const [k, v] of Object.entries(obj)) {
    const lower = k.toLowerCase()
    for (const [outKey, aliases] of Object.entries(targets)) {
      if (found[outKey] != null) continue
      if (aliases.includes(lower)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          const s = String(v).trim()
          if (s) found[outKey] = s
        }
      }
    }
    if (typeof v === 'object' || (typeof v === 'string' && v.trim().startsWith('{'))) {
      deepFindKeys(v, targets, found, depth + 1)
    }
  }
  return found
}

export function extractPriceMeta(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const found = deepFindKeys(metadata, {
    curso: ['curso', 'nome', 'nome_curso', 'course', 'name'],
    tipo: ['tipo', 'nivel', 'grau', 'grau_curso', 'level', 'category'],
    modalidade: ['modalidade', 'modalidades', 'modality'],
    tempo: ['tempo', 'duracao', 'duracao_curso', 'duration'],
    valor: ['valor', 'preco', 'preco_mensal', 'mensalidade', 'price'],
  })
  if (!found.curso && !found.tipo && !found.modalidade && !found.tempo && !found.valor) return null
  return found
}

export function isPosTipo(tipo) {
  if (!tipo) return false
  return /(p[óo]s|mba|especializa)/i.test(String(tipo).toLowerCase())
}

/**
 * Faculdade Sumaré oferta EAD e Semipresencial (a planilha oficial define a
 * modalidade real de cada curso). Aqui apenas padronizamos a grafia para
 * "Semipresencial" — NÃO forçamos mais tudo para EAD.
 */
export function normalizeModalidadeForSumare(value) {
  const s = String(value || '').trim()
  if (!s) return s
  if (/semi-?\s*presen/i.test(s)) return 'Semipresencial'
  return s
}

export function normalizeModalidadeInText(text) {
  return String(text || '')
    .replace(/modalidade:\s*Semi-?\s*Presencial/gi, 'modalidade: Semipresencial')
    .replace(/(?<![A-Za-zÁÉÍÓÚÃÕÇ])Semi-?\s*Presencial/gi, 'Semipresencial')
}

const NOISE_KEYS = new Set([
  'loc', 'source', 'blobtype', 'pdf', 'pagenumber', 'totalpages',
  'lines', 'embedding', 'id',
])

export function summarizeMetadataForLLM(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const cleaned = {}
  for (const [k, v] of Object.entries(metadata)) {
    if (NOISE_KEYS.has(k.toLowerCase())) continue
    if (v == null) continue
    if (typeof v === 'string') {
      const t = v.trim()
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { cleaned[k] = JSON.parse(t); continue } catch { /* ignore */ }
      }
      cleaned[k] = v
    } else {
      cleaned[k] = v
    }
  }
  if (Object.keys(cleaned).length === 0) return null
  let s
  try { s = JSON.stringify(cleaned) } catch { return null }
  if (s.length > 280) s = s.slice(0, 277) + '...'
  return s
}

/**
 * @param {'pos_info'|'pos_preco'|'grad_info'|'grad_preco'|'grad_grade_curricular'} source
 * @param {{ content?: string, metadata?: object }} d
 */
export function enrichRowContentForRag(source, d) {
  const base = normalizeModalidadeInText(d?.content || '')

  if (source === 'grad_grade_curricular') {
    const meta = d?.metadata && typeof d.metadata === 'object' ? d.metadata : {}
    const partes = [base]
    if (meta.curso_nome && meta.modalidade) {
      partes.push(
        `[GRADE CURRICULAR — ${meta.curso_nome} (${meta.modalidade}) | ${meta.total_disciplinas || 0} disciplinas | codigo: ${meta.codigo_api || 'n/a'}]`,
      )
    }
    if (Array.isArray(meta.disciplinas) && meta.disciplinas.length) {
      const lista = meta.disciplinas.map((disc, i) => `${i + 1}. ${disc}`).join('\n')
      partes.push(`LISTA DE DISCIPLINAS:\n${lista}`)
    }
    if (meta.url_pagina) partes.push(`[FONTE OFICIAL: ${meta.url_pagina}]`)
    partes.push(
      '[STATUS DA GRADE: PDF DISPONIVEL — chame enviar_grade_pdf com curso e modalidade para enviar o PDF. PROIBIDO dizer que não tem PDF.]',
    )
    return partes.join('\n\n')
  }

  if (source === 'grad_info' || source === 'pos_info') {
    const meta = d?.metadata && typeof d.metadata === 'object' ? d.metadata : {}
    if (meta.kind === 'grade_curricular') {
      const nivelLabel = meta.nivel === 'pos' ? 'PÓS-GRADUAÇÃO' : 'GRADUAÇÃO'
      const partes = [base]
      partes.push(
        `[GRADE CURRICULAR — ${nivelLabel} — ${meta.curso_nome || 'curso'} (${meta.modalidade || ''}) | ${meta.total_disciplinas || 0} disciplinas]`,
      )
      if (Array.isArray(meta.disciplinas) && meta.disciplinas.length) {
        partes.push(`LISTA DE DISCIPLINAS:\n${meta.disciplinas.map((disc, i) => `${i + 1}. ${disc}`).join('\n')}`)
      }
      if (meta.url_pagina) partes.push(`[FONTE OFICIAL: ${meta.url_pagina}]`)
      partes.push(
        '[STATUS DA GRADE: PDF DISPONIVEL — chame a tool enviar_grade_pdf com curso e modalidade para enviar o PDF completo ao lead. PROIBIDO dizer que não tem PDF.]',
      )
      return partes.join('\n\n')
    }

    const partes = [base]
    const courseLabel = extractCourseNameFromGradContent(base) || base
    const perfilBlock = formatPerfilBlockForRag(getCursoPerfil(courseLabel))
    if (perfilBlock) partes.push(perfilBlock)
    const gradeUrl = extractGradeLink(d?.metadata)
    const gradeStatus = gradeUrl
      ? `STATUS DA GRADE: DISPONIVEL — link oficial: ${gradeUrl}`
      : 'STATUS DA GRADE: NAO DISPONIVEL — não existe link/PDF da grade deste curso na nossa base.'
    partes.push(`[${gradeStatus}]`)
    if (source === 'grad_info') {
      const estagioInfo = extractEstagioInfo(d?.metadata)
      const estagioMarker = formatEstagioMarker(estagioInfo)
      if (estagioMarker) partes.push(`[${estagioMarker}]`)
    }
    return partes.join('\n\n')
  }

  if (source === 'pos_preco' || source === 'grad_preco') {
    const meta = extractPriceMeta(d?.metadata)
    const lines = [base]
    if (meta) {
      const fields = []
      if (meta.curso) fields.push(`curso: ${meta.curso}`)
      if (meta.tipo) {
        const nivel = isPosTipo(meta.tipo) ? 'PÓS-GRADUAÇÃO' : 'GRADUAÇÃO'
        fields.push(`nivel: ${nivel} (tipo bruto: ${meta.tipo})`)
      }
      if (meta.modalidade) fields.push(`modalidade: ${normalizeModalidadeForSumare(meta.modalidade)}`)
      if (meta.tempo) fields.push(`duracao: ${meta.tempo}`)
      if (meta.valor) fields.push(`valor: ${meta.valor}`)
      lines.push(`[FICHA DO PRECO — ${fields.join(' | ')}]`)
    }
    let rawDump = null
    try {
      const compact = JSON.stringify(d?.metadata ?? null)
      if (compact && compact !== 'null' && compact !== '{}') {
        rawDump = compact.length > 500 ? compact.slice(0, 497) + '...' : compact
      }
    } catch { /* ignore */ }
    if (rawDump) lines.push(`[METADATA BRUTO — ${rawDump}]`)
    if (lines.length === 1) return base
    return lines.join('\n\n')
  }

  return base
}
