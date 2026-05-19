/** Cursos que a Sumaré não oferece (ex.: técnico) — redirecionar para graduação na mesma área. */

import { normalizeMessageForScope } from './scopeHeuristics.js'

/**
 * Pergunta por curso técnico / profissionalizante (não confundir com tecnólogo = graduação).
 */
export function messageAsksUnsupportedCourseLevel(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 8) return false

  if (/\btecn[oó]log[oa]s?\b/i.test(t) && !/\bcursos?\s+t[eé]cnicos?\b/i.test(t) && !/\bcurso\s+t[eé]cnico\b/i.test(t)) {
    return false
  }

  return (
    /\bcursos?\s+t[eé]cnicos?\b/i.test(t) ||
    /\bcurso\s+t[eé]cnico\b/i.test(t) ||
    /\bt[eé]cnico\s+profissionalizante\b/i.test(t) ||
    /\b(n[ií]vel|forma[cç][aã]o)\s+t[eé]cnica?\b/i.test(t) ||
    /\bqualifica[cç][aã]o\s+profissional\b/i.test(t) ||
    (/\bcurso\b/i.test(t) && /\bprofissionalizante\b/i.test(t))
  )
}

export function buildTechnicalCourseSearchQuery(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (/\b(sa[uú]de|enferm|fisio|nutri|farm[aá]cia|biomedic|hospital)\b/i.test(t)) {
    return 'graduação EAD saúde enfermagem fisioterapia nutrição biomedicina'
  }
  if (/\b(administra|gest[aã]o|contab|marketing|vendas|comercial|empres)\b/i.test(t)) {
    return 'graduação EAD administração gestão marketing contabilidade'
  }
  if (/\b(inform[aá]tica|ti\b|programa[cç][aã]o|software|sistemas|dados)\b/i.test(t)) {
    return 'graduação EAD tecnologia sistemas informação análise de dados'
  }
  if (/\b(mec[aâ]nic|el[eé]tric|automot|ind[uú]stria|produ[cç][aã]o)\b/i.test(t)) {
    return 'graduação EAD engenharia mecânica elétrica produção'
  }
  if (/\b(educa[cç][aã]o|pedagog|professor)\b/i.test(t)) {
    return 'graduação EAD pedagogia licenciatura educação'
  }
  return 'graduação EAD tecnólogo cursos disponíveis área profissional'
}

/** Extrai nomes de cursos citados no bloco CONTEXT do RAG. */
export function extractCourseNamesFromKnowledgeText(searchText) {
  const text = String(searchText || '')
  const found = new Set()
  const patterns = [
    /(?:curso|gradua[cç][aã]o|bacharelado|licenciatura|tecn[oó]logo)\s*[:\-]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{2,42})/gi,
    /nome\s+do\s+curso\s*[:\-]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{2,42})/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(text)) !== null) {
      const name = m[1].trim().replace(/\s+/g, ' ')
      if (name.length >= 4 && name.length <= 45 && !/faculdade|sumar[eé]|ead/i.test(name)) {
        found.add(name.charAt(0).toUpperCase() + name.slice(1))
      }
    }
  }
  return [...found].slice(0, 4)
}

export function buildUnsupportedCourseLevelReply({ userMessage, searchText, pushName }) {
  const firstName = String(pushName || '').trim().split(/\s+/)[0]
  const nameBit = firstName && firstName.length >= 2 && !/^\d+$/.test(firstName) ? `, ${firstName}` : ''
  const courses = extractCourseNamesFromKnowledgeText(searchText)

  let body =
    `Ótima pergunta${nameBit}! A Faculdade Sumaré **não oferece cursos técnicos** (nível médio ou profissionalizante). ` +
    `Trabalhamos com **graduação** e **pós-graduação** na modalidade **EAD**.\n\n`

  if (courses.length > 0) {
    const list =
      courses.length === 1
        ? courses[0]
        : `${courses.slice(0, -1).join(', ')} e ${courses[courses.length - 1]}`
    body +=
      `Na mesma linha da sua busca, temos graduações EAD como: **${list}**. ` +
      `Quer que eu te passe valores, duração e como funciona a matrícula em algum deles?`
  } else {
    body +=
      'Posso te indicar graduações EAD na área que você procura — me conta um pouco mais a área de interesse ' +
      '(saúde, gestão, tecnologia, educação…) que busco as melhores opções para você.'
  }

  return body
}
