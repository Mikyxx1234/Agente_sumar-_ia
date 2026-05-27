/**
 * Interpreta a resposta da API GET /api-ingresso/candidato/gerar (campo `pagina`).
 * Usado para distinguir inscrição nova, mesmo curso em andamento ou múltiplas candidaturas.
 */

function extractCandidatoIdFromGerar(data) {
  if (data == null) return null
  if (typeof data === 'string' || typeof data === 'number') {
    const s = String(data).trim()
    return s.length >= 8 ? s : null
  }
  const candidates = [data.candidato, data.candidatoId, data.id, data?.data?.candidato]
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim()
  }
  return null
}

export function normalizeCursoNomeKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** @returns {object|null} */
export function parseGerarCandidatoPayload(data) {
  if (data == null) return null
  if (typeof data === 'string') {
    if (/^\s*</.test(data)) return null
    try {
      return parseGerarCandidatoPayload(JSON.parse(data))
    } catch {
      return null
    }
  }
  if (typeof data !== 'object') return null

  const inscricoes = Array.isArray(data.inscricoes)
    ? data.inscricoes
    : Array.isArray(data.candidaturas)
      ? data.candidaturas
      : Array.isArray(data.listaInscricoes)
        ? data.listaInscricoes
        : null

  return {
    pagina: String(data.pagina || '').trim(),
    candidatoId: extractCandidatoIdFromGerar(data),
    cursoCodigo: String(data.curso || '').trim().toUpperCase(),
    nomeCurso: String(data.nomeCurso || data.nome_curso || '').trim(),
    inscricoes,
  }
}

/**
 * @param {{ nome?: string, codigo?: string }} requested
 * @param {{ cursoCodigo?: string, nomeCurso?: string }} api
 */
export function coursesMatch(requested, api) {
  const rc = String(requested?.codigo || '').trim().toUpperCase()
  const ac = String(api?.cursoCodigo || '').trim().toUpperCase()
  if (rc && ac && rc === ac) return true

  const rk = normalizeCursoNomeKey(requested?.nome)
  const ak = normalizeCursoNomeKey(api?.nomeCurso)
  if (!rk || !ak) return false
  if (rk === ak) return true
  if (ak.includes(rk) || rk.includes(ak)) return true

  const rkTokens = rk.split(/\s+/).filter((t) => t.length > 3)
  if (rkTokens.length >= 2 && rkTokens.every((t) => ak.includes(t))) return true
  return false
}

/**
 * @param {ReturnType<typeof parseGerarCandidatoPayload>} parsed
 * @param {{ nome?: string, codigo?: string }} requested
 */
export function classifyGerarCandidatoOutcome(parsed, requested) {
  if (!parsed?.candidatoId) {
    return { kind: 'unknown', parsed }
  }

  const pagina = parsed.pagina.toLowerCase()
  const sameCourse = coursesMatch(
    { nome: requested?.nome, codigo: requested?.codigo },
    { cursoCodigo: parsed.cursoCodigo, nomeCurso: parsed.nomeCurso },
  )

  if (pagina === 'candidato' || (parsed.inscricoes && parsed.inscricoes.length > 1)) {
    return { kind: 'multiple_inscricoes_portal', parsed, sameCourse }
  }

  if (pagina === 'pagamento' && sameCourse) {
    return { kind: 'same_course_in_progress', parsed, sameCourse: true }
  }

  if (pagina === 'contrato' && sameCourse) {
    return { kind: 'same_course_contract', parsed, sameCourse: true }
  }

  if (pagina === 'contrato' && !sameCourse) {
    return { kind: 'different_course_new', parsed, sameCourse: false }
  }

  if (pagina === 'pagamento' && !sameCourse) {
    return { kind: 'different_course_payment', parsed, sameCourse: false }
  }

  return { kind: 'default', parsed, sameCourse }
}

export function messageConfirmsNovaInscricao(text) {
  const t = String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
  if (!t || t.length > 80) return false
  return /^(sim|s|quero|pode|bora|vamos|ok|confirmo|isso|claro|pode ser|t[aá]|ta)\b/.test(t)
}

export function messageDeclinesNovaInscricao(text) {
  const t = String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
  if (!t || t.length > 120) return false
  return /^(n[aã]o|nao|n|negativo|prefiro\s+n[aã]o|melhor\s+n[aã]o)\b/.test(t)
}
