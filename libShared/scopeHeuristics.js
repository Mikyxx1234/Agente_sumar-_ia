/** Heurísticas compartilhadas (browser + Node) para bloquear perguntas fora do escopo. */

export const DEFAULT_SCOPE_REFUSAL =
  'Olá! Sou o assistente da Faculdade Sumaré e posso te ajudar com cursos, valores, matrícula e informações sobre nossos programas de graduação e pós-graduação (EAD). ' +
  'Sua pergunta foge desse atendimento — tem alguma dúvida sobre nossos cursos ou sobre como se matricular?'

/** Indica que a mensagem trata de oferta educacional Sumaré. */
export function messageLooksEducational(text) {
  const t = String(text || '').toLowerCase()
  if (messageLooksCareerIncomeOpportunity(text)) return true
  return /\b(curso|cursos|gradua[cç][aã]o|p[oó]s|mba|especializa|matr[ií]cula|inscri|mensalidade|faculdade|sumar[eé]|ead|bolsa|vestibular|enem|grade|modalidade|diploma|disciplina|aulas?|tcc|cr[eé]dito|tecn[oó]logo|licenciatura|bacharelado)\b/i.test(t)
}

/**
 * Lead fala de dinheiro, carreira ou mundo digital — oportunidade de sugerir formação (não recusar).
 */
export function messageLooksCareerIncomeOpportunity(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 8) return false
  if (containsSqlLikeContent(t)) return false
  if (/\bqual\s+(é|e)\s+a\s+capital\b/i.test(t)) return false
  if (/\b(capital|presidente|habitantes)\s+(da|de|do)\s+/i.test(t) && !/\b(curso|faculdade|matr[ií]cula)\b/i.test(t)) return false

  const moneyCareer =
    /\b(ganhar|ganho|ganhando|dinheiro|grana|renda|sal[aá]rio|enriquecer|ficar\s+rico|liberdade\s+financeira|independ[eê]ncia\s+financeira)\b/i.test(t) ||
    /\b(mundo\s+digital|mercado\s+digital|economia\s+digital|trabalhar\s+(na\s+)?internet|home\s*office|trabalho\s+remoto|trabalhar\s+online)\b/i.test(t) ||
    /\b(carreira|emprego|empregabilidade|recoloca[cç][aã]o|vagas?|profiss[aã]o|futuro\s+profissional|ascens[aã]o)\b/i.test(t) ||
    /\b(mudar\s+de\s+vida|novo\s+rumo|crescimento\s+profissional|investir\s+em\s+mim|melhorar\s+de\s+vida)\b/i.test(t) ||
    /\b(como\s+(fazer|conseguir|ter))\b[\s\S]{0,40}\b(dinheiro|renda|emprego|carreira)\b/i.test(t)

  return moneyCareer
}

/** Termos sugeridos para buscar_conhecimento em oportunidade comercial. */
export function buildCommercialRedirectSearchQuery(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (/\b(mundo\s+digital|marketing\s+digital|redes\s+sociais|e-?commerce|empreendedor|startup)\b/i.test(t)) {
    return 'marketing digital tecnologia gestão empreendedorismo graduação EAD'
  }
  if (/\b(programa[cç][aã]o|software|ti\b|tecnologia\s+da\s+informa)/i.test(t)) {
    return 'tecnologia informação sistemas desenvolvimento graduação EAD'
  }
  if (/\b(sa[uú]de|hospital|enfermagem|m[eé]dic)\b/i.test(t)) {
    return 'saúde enfermagem graduação EAD'
  }
  if (/\b(advogad|direito|jur[ií]dic)\b/i.test(t)) {
    return 'direito graduação EAD'
  }
  if (/\b(dinheiro|rico|renda|financeir|investir)\b/i.test(t)) {
    return 'administração gestão negócios empreendedorismo graduação EAD'
  }
  return 'graduação EAD carreira mercado de trabalho formação superior'
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

function compactForGreetingMatch(text) {
  return normalizeMessageForScope(text)
    .toLowerCase()
    .replace(/[!?.…,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const GREETING_ONLY_PATTERNS = [
  /^bom\s+dia$/,
  /^boa\s+tarde$/,
  /^boa\s+noite$/,
  /^bom\s+dia\s+tudo\s+bem$/,
  /^boa\s+tarde\s+tudo\s+bem$/,
  /^boa\s+noite\s+tudo\s+bem$/,
  /^oi+$/,
  /^ol[aá]+$/,
  /^opa$/,
  /^e\s*a[ií]+$/,
  /^eae$/,
  /^hey$/,
  /^hello$/,
  /^hi$/,
  /^salve$/,
  /^fala$/,
  /^tudo\s+bem$/,
  /^tudo\s+bom$/,
  /^como\s+vai$/,
  /^como\s+vc\s+vai$/,
  /^como\s+voce\s+vai$/,
  /^bom$/,
]

/** Saudação pura, sem pedido de curso/preço/matrícula na mesma mensagem. */
export function isGreetingOnly(text) {
  const t = compactForGreetingMatch(text)
  if (!t || t.length > 55) return false

  if (
    /\b(curso|cursos|matr[ií]cula|inscri|pre[cç]o|valor|mensalidade|gradua|p[oó]s|mba|enem|vestibular|bolsa|ead)\b/i.test(t)
  ) {
    return false
  }
  if (/\b(quero|preciso|gostaria|voc[eê]s\s+tem|tem\s+como|quanto\s+custa|informa[cç][aã]o\s+sobre)\b/i.test(t) && t.length > 18) {
    return false
  }

  return GREETING_ONLY_PATTERNS.some((re) => re.test(t))
}

function extractFirstName(pushName) {
  const raw = String(pushName || '').trim().split(/\s+/)[0] || ''
  if (!raw || raw.length < 2) return ''
  if (/^\d+$/.test(raw)) return ''
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
}

/** Lead pede atendimento humano / consultor / atendente. */
export function messageRequestsHuman(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 5) return false
  if (isGreetingOnly(text) && !/\b(humano|atendente|consultor|algu[eé]m|pessoa)\b/i.test(t)) return false

  if (
    /\b(falar|falo|conversar|quero|preciso|passa|me\s+(passa|conecta|liga|transfere)|chama)\b[\s\S]{0,55}\b(humano|humana|atendente|consultor|pessoa|algu[eé]m|gente|operador|representante)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\b(quero|preciso)\s+falar\s+com\b/i.test(t)) return true
  if (/\bfalar\s+com\s+(um\s+)?(humano|atendente|consultor|algu[eé]m|pessoa)\b/i.test(t)) return true
  if (/\b(humano|atendente|consultor|pessoa\s+real)\b[\s\S]{0,45}\b(por\s+favor|pfv|agora|já|ja|logo|rápido|rapido)\b/i.test(t)) return true
  if (/\batendimento\s+humano\b/i.test(t)) return true
  if (/\b(especialista|operador|representante)\b[\s\S]{0,40}\b(por\s+favor|pfv|agora)\b/i.test(t)) return true
  if (
    /\b(só|somente|apenas)\b[\s\S]{0,40}\b(falar|conversar|quero)\b[\s\S]{0,40}\b(humano|algu[eé]m|consultor|atendente|pessoa)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (
    /\bnão\s+quero\b[\s\S]{0,55}\b(curso|informa|ajuda\s+r[aá]pida|nada\s+disso)\b/i.test(t) &&
    /\b(humano|algu[eé]m|consultor|atendente|pessoa)\b/i.test(t)
  ) {
    return true
  }
  return false
}

/** Frustração depois de já ter pedido humano no histórico recente. */
export function userFrustratedAfterHumanRequest(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  return /\b(ser[aá]?\s+que\s+voce\s+entende|voc[eê]\s+entende|não\s+entende|nao\s+entende|não\s+adianta|nao\s+adianta)\b/i.test(t)
}

/** Mensagem de teste/homologação da equipe — não dispara salesbot ao reentrar no funil. */
export function messageLooksLikeOperationalChat(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 6) return false
  if (
    /\b(testando|teste|testar|homolog|homologa[cç][aã]o)\b[\s\S]{0,55}\b(robo|robô|rob[oô]|bot|agente|ia)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\b(robo|robô|bot)\b[\s\S]{0,45}\b(atendimento|comercial)\b/i.test(t) && /\b(teste|testando|ajudar\s+voc[eê]s)\b/i.test(t)) {
    return true
  }
  if (/\b(sou\s+da\s+equipe|equipe\s+interna|time\s+interno|uso\s+interno)\b/i.test(t)) return true
  return false
}

/** Deve executar distribuir_humano + salesbot consultor (não só responder em texto). */
export function shouldHandoffToHuman(userMessage, historyMessages = []) {
  if (messageLooksLikeOperationalChat(userMessage) && !messageRequestsHuman(userMessage)) return false
  if (messageRequestsHuman(userMessage)) return true
  if (userFrustratedAfterHumanRequest(userMessage)) {
    const recentUser = (historyMessages || [])
      .filter((m) => m.role === 'user')
      .slice(-6)
      .map((m) => m.content)
    return recentUser.some((c) => messageRequestsHuman(c))
  }
  return false
}

const MATRICULA_INTENT_RE =
  /\b(matr[ií]cula|inscri[cç][aã]o|me\s+inscrever|quero\s+me\s+matricular|fazer\s+(a\s+)?inscri[cç][aã]o|garantir\s+(a\s+)?vaga|quero\s+me\s+inscrever)\b/i
const INGRESSO_RE =
  /\b(enem|vestibular|ingresso|transfer[eê]ncia|segunda\s+gradua[cç][aã]o|m[uú]ltipla\s+escolha)\b/i

function recentUserTexts(historyMessages, max = 4) {
  return (historyMessages || [])
    .filter((m) => m.role === 'user')
    .slice(-max)
    .map((m) => normalizeMessageForScope(m.content).toLowerCase())
}

/**
 * Matrícula automática (salesbot 49813) só quando o lead pede NESTE turno.
 * Histórico antigo (ex.: lead voltou ao funil da IA) não pode reativar o fluxo.
 */
export function detectMatriculaHandoffIntent(userMessage, historyMessages = []) {
  const current = normalizeMessageForScope(userMessage).toLowerCase()
  if (!current || current.length < 8) return false
  if (messageLooksLikeOperationalChat(userMessage)) return false
  if (!MATRICULA_INTENT_RE.test(current)) return false

  const hasIngresso =
    INGRESSO_RE.test(current) || recentUserTexts(historyMessages).some((t) => INGRESSO_RE.test(t))
  const hasCurso =
    /\bcurso\b/i.test(current) ||
    recentUserTexts(historyMessages).some((t) => /\bcurso\b/i.test(t))

  return hasIngresso && hasCurso
}

/** Encaminhamento automático: só consultor (49777). Matrícula usa fluxo Form Sumar. */
export function detectHandoffMotivo() {
  return 'consultor'
}

/** Resposta ao lead após encaminhamento automático para consultor. */
export function buildHumanHandoffReply(opts = {}) {
  const nameBit = extractFirstName(opts.pushName) ? `, ${extractFirstName(opts.pushName)}` : ''
  const matricula = opts.motivo === 'matricula'
  if (opts.ok) {
    if (matricula) {
      return (
        `Perfeito${nameBit}! Já encaminhei seus dados para um consultor finalizar sua matrícula — em breve alguém da equipe da Faculdade Sumaré fala com você por aqui, tudo bem?`
      )
    }
    return (
      `Entendi${nameBit}! Já encaminhei seu atendimento para um consultor da Faculdade Sumaré — em breve alguém da equipe fala com você por aqui, tudo bem?`
    )
  }
  return (
    `Peço desculpas pela espera${nameBit}. Registrei seu pedido e um consultor da Faculdade Sumaré entrará em contato em breve para te atender pessoalmente.`
  )
}

/** Resposta cordial para saudação simples (sem chamar o orquestrador). */
export function buildGreetingReply(opts = {}) {
  const userMessage = opts.userMessage || ''
  const firstName = extractFirstName(opts.pushName)
  const nameBit = firstName ? `, ${firstName}` : ''

  const t = compactForGreetingMatch(userMessage)
  let open = `Olá${nameBit}!`
  if (/^bom\s+dia/.test(t)) open = `Bom dia${nameBit}!`
  else if (/^boa\s+tarde/.test(t)) open = `Boa tarde${nameBit}!`
  else if (/^boa\s+noite/.test(t)) open = `Boa noite${nameBit}!`

  return (
    `${open} Seja bem-vindo(a) à Faculdade Sumaré. ` +
    'Sou seu assistente virtual e estou aqui para te ajudar com cursos EAD de graduação e pós-graduação, valores, matrícula e inscrição. ' +
    'Como posso te ajudar hoje? Já tem algum curso em mente ou quer conhecer as opções?'
  )
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

  if (isGreetingOnly(t)) return null

  // Import dinâmico evitado — checagem inline para não criar dependência circular
  if (
    /\bcursos?\s+t[eé]cnicos?\b/i.test(t) ||
    /\bcurso\s+t[eé]cnico\b/i.test(t) ||
    /\bt[eé]cnico\s+profissionalizante\b/i.test(t)
  ) {
    return null
  }

  if (messageLooksCareerIncomeOpportunity(t)) return null

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
