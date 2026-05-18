/** Heurísticas compartilhadas (browser + Node) para bloquear perguntas fora do escopo. */

export const DEFAULT_SCOPE_REFUSAL =
  'Olá! Sou o assistente da Faculdade Sumaré e posso te ajudar com cursos, valores, matrícula e informações sobre nossos programas de graduação e pós-graduação (EAD). ' +
  'Sua pergunta foge desse atendimento — tem alguma dúvida sobre nossos cursos ou sobre como se matricular?'

/** Indica que a mensagem trata de oferta educacional Sumaré. */
export function messageLooksEducational(text) {
  const t = String(text || '').toLowerCase()
  return /\b(curso|cursos|gradua[cç][aã]o|p[oó]s|mba|especializa|matr[ií]cula|inscri|mensalidade|faculdade|sumar[eé]|ead|bolsa|vestibular|enem|grade|modalidade|diploma|disciplina|aulas?|tcc|cr[eé]dito|tecn[oó]logo|licenciatura|bacharelado)\b/i.test(t)
}

/** SQL, DML ou sintaxe de banco — sempre fora do escopo do agente comercial. */
export function containsSqlLikeContent(text) {
  const t = String(text || '')
  const u = t.toUpperCase()
  if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/.test(u)) {
    if (/\b(FROM|INTO|SET|WHERE|TABLE|JOIN|VALUES|DATABASE)\b/.test(u)) return true
    if (/\bUPDATE\b/.test(u) && /\bSET\b/.test(u)) return true
    if (/\bINSERT\b/.test(u) && /\bINTO\b/.test(u)) return true
    if (/\bDELETE\b/.test(u) && /\bFROM\b/.test(u)) return true
  }
  if (/\bpublic\.\w+/i.test(t)) return true
  if (/\b(lower|trim|coalesce|count)\s*\(/i.test(t)) return true
  if (/\bWHERE\b[\s\S]{0,200}\b(OR|AND)\b/i.test(u)) return true
  return false
}

const OUT_OF_SCOPE_PATTERNS = [
  /\b(o\s*que|oque)\b[\s\S]{0,30}\b(essa\s+)?(query|consulta)\b/i,
  /\b(query|consulta)\b[\s\S]{0,25}\b(faz|significa|serve|quer\s+dizer)\b/i,
  /\b(explique|me\s+explica)\b[\s\S]{0,30}\b(query|consulta|sql)\b/i,
  /\b(como\s+(eu\s+)?(faço|faria|montar?|criar?|escrev))\b[\s\S]{0,70}\b(sql|query|consulta|tabela\s+vetor|vetorizada?)/i,
  /\b(situa[cç][aã]o|rela[cç][oõ]es?)\s+(comercial|comércio|negócios)\b[\s\S]{0,100}\b(china|eua|usa|estados\s+unidos|taiwan)\b/i,
  /\b(trump|guerra|elei[cç][aã]o|not[ií]cia\s+pol[ií]tica|geopol[ií]tica)\b/i,
  /\b(programa[cç][aã]o|python|javascript|node\.?js|typescript)\b[\s\S]{0,50}\b(código|api\s+rest|backend)\b/i,
  /\bqual\s+(é|e)\s+a\s+capital\b/i,
  /\bcapital\s+(da|de|do|dos|das)\s+/i,
  /\b(quem|quantos?)\s+(é|e|são|sao)\s+(o\s+)?(presidente|primeiro\s+ministro|habitantes|popula)/i,
  /\b(clima|temperatura|fuso\s+hor[aá]rio)\s+(em|de|da|do)\b/i,
  /\b(receita\s+de|como\s+cozinhar|ingredientes\s+para)\b/i,
  /\b(quem\s+inventou|quando\s+nasceu|história\s+do\s+país)\b/i,
  /\b(como\s+est[aá])\s+.{0,30}\b(china|eua|usa|brasil|r[uú]ssia|ucr[aâ]nia)\b/i,
  /\b(tarifa|guerra\s+comercial|exporta[cç][aã]o)\b[\s\S]{0,60}\b(china|eua|usa)\b/i,
  /\b(planilha\s+excel|google\s+sheets|power\s*bi)\b/i,
  /\b(chat\s*gpt|openai|intelig[eê]ncia\s+artificial)\b(?!.*\b(curso|faculdade|matr[ií]cula)\b)/i,
  /\b(leads?\s+duplicados?|tabela\s+vetor|banco\s+de\s+dados)\b/i,
  /\b(supabase|postgres|postgresql|mysql|sql\s+server)\b/i,
]

export function normalizeMessageForScope(text) {
  let t = String(text || '').trim()
  t = t.replace(/^\[ÁUDIO TRANSCRITO\]:\s*/i, '')
  t = t.replace(/^\[IMAGEM RECEBIDA[^\]]*\]:\s*/i, '')
  t = t.replace(/^\[Mensagem digitada junto\]:\s*/i, '')
  t = t.replace(/^\[Legenda[^\]]*\]:\s*/i, '')
  return t.trim()
}

function outOfScopeResult(motivo) {
  return {
    dentro_escopo: false,
    categoria: 'fora_escopo',
    nivel: 'indefinido',
    motivo,
  }
}

/**
 * Retorna classificação fora_escopo ou null.
 */
export function matchScopeHeuristic(text) {
  const t = normalizeMessageForScope(text)
  if (!t || t.length < 4) return null

  if (containsSqlLikeContent(t)) {
    return outOfScopeResult('heurística: SQL ou consulta de banco de dados')
  }

  if (messageLooksEducational(t)) return null

  for (const re of OUT_OF_SCOPE_PATTERNS) {
    if (re.test(t)) {
      return outOfScopeResult('heurística: tema sem relação com cursos ou matrícula')
    }
  }
  return null
}
