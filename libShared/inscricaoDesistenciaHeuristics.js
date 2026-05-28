/**
 * Heurísticas do fluxo de desistência de inscrição (lead não quer seguir
 * após o agente apresentar o curso e tirar dúvidas).
 */

import { normalizeMessageForScope } from './scopeHeuristics.js'
import {
  conversationHasActiveTopic,
  assistantAskedEnrollmentInLastReply,
  lastAssistantText,
} from './conversationContextHeuristics.js'
import { messageConfirmsProceedToInscricaoForm } from './inscricaoFormHeuristics.js'

/** Assistente pediu confirmação de desistência (texto canônico deste fluxo). */
export function assistantAskedDesistenciaConfirm(text) {
  const a = String(text || '')
    .replace(/\s-\s+EX-\d{6}-\d{4}-\d{3}(-[a-f0-9]+)?\s*$/i, '')
    .toLowerCase()
  if (!a) return false
  return (
    /\bn[aã]o\s+deseja\s+mesmo\s+seguir\b/i.test(a) &&
    /\b(desist[eê]ncia|desistir)\b/i.test(a) &&
    (/\bconfirme\b/i.test(a) || /\bconfirmo\b/i.test(a) || /responda\s+por\s+aqui/i.test(a))
  )
}

/**
 * Houve engajamento sobre curso: agente falou do curso e o lead participou
 * (perguntas, dúvidas) antes de declarar que não quer inscrição.
 */
export function conversationHadCourseEngagement(historyMessages = []) {
  if (!conversationHasActiveTopic(historyMessages)) return false

  let assistantCourseTurns = 0
  let userParticipated = false

  for (const m of historyMessages || []) {
    const content = String(m?.content || '')
    const role = String(m?.role || '').toLowerCase()
    if (role === 'assistant' || role === 'assistente') {
      if (
        /\b(curso|gradua[cç][aã]o|ead|mensalidade|matr[ií]cula|inscri[cç][aã]o|valor|pre[cç]o|dura[cç][aã]o|grade|vestibular|ingresso)\b/i.test(
          content,
        )
      ) {
        assistantCourseTurns += 1
      }
    }
    if (role === 'user' || role === 'lead') {
      const t = normalizeMessageForScope(content)
      if (t.length >= 6 && !/^(oi|ol[aá]|bom dia|boa tarde|boa noite)\s*$/i.test(t)) {
        userParticipated = true
      }
    }
  }

  return assistantCourseTurns >= 1 && userParticipated
}

/**
 * Padrões condicionais ("se não tiver", "caso não", "senão", "se não der")
 * que NÃO devem ser interpretados como recusa de inscrição. Cobrem casos
 * tipo "se não tiver veterinária, quero pediatria".
 */
const CONDICIONAL_NEGATIVO_RE =
  /\b(se\s+n[aã]o|caso\s+n[aã]o|sen[aã]o|se\s+n[aã]o\s+(tiver|for|der|puder|houver))\b/i

/**
 * Lead acabou de pedir/citar outro curso ("ou o curso de X", "ent[aã]o quero Y").
 * É plano B, não desistência.
 */
const PLANO_B_CURSO_RE = /\b(ou\s+(o|a)\s+curso|prefiro|ent[aã]o\s+(quero|prefiro)|tamb[eé]m\s+(quero|gostaria))\b/i

/** Verbo de inscrição/matrícula adjacente à negação. */
const NEGACAO_DIRETA_INSCRICAO_RE =
  /\bn[aã]o\s+(quero|vou|pretendo|desejo|tenho\s+interesse|posso|consigo)\s+(me\s+|de\s+|em\s+|com\s+a\s+|a\s+)?(inscrever|matricular|fazer\s+a\s+(inscri[cç][aã]o|matr[ií]cula)|seguir|prosseguir|continuar|avan[cç]ar)\b/i

/**
 * Interesse positivo EXPLÍCITO em curso/inscrição/matrícula — NUNCA pode ser
 * tratado como declínio, mesmo se outras regras casarem por acidente.
 *
 * Exige: verbo positivo ("quero", "gostaria", "preciso", "vou", "tenho interesse",
 * "vou fazer", "fazer") + alvo (curso, inscrição, matrícula, estudar, graduar,
 * pós, EAD, vestibular) — SEM "não" antes do verbo.
 */
const INTERESSE_POSITIVO_INSCRICAO_RE =
  /\b(quero|gostaria|preciso|vou|pretendo|desejo|tenho\s+interesse(?:\s+em)?|me\s+interesso|gostei|posso|adoraria|fazer)\b[\s\S]{0,30}\b(curso|inscri[cç][aã]o|matr[ií]cula|matricular|inscrever|estudar|graduar|gradua[cç][aã]o|p[oó]s|ead|vestibular|formar)\b/i

function hasInteressePositivoNoNeg(t) {
  if (!INTERESSE_POSITIVO_INSCRICAO_RE.test(t)) return false
  // Bloqueia se houver "não" ANTES do verbo positivo (ex.: "não quero curso")
  const m = t.match(INTERESSE_POSITIVO_INSCRICAO_RE)
  if (!m) return false
  const idx = t.indexOf(m[0])
  const before = t.slice(Math.max(0, idx - 12), idx)
  if (/\bn[aã]o\s*$/i.test(before.trim())) return false
  return true
}

/**
 * Lead declarou que não quer seguir com a inscrição / matrícula.
 *
 * Heurística conservadora em camadas:
 *  • Frases com interesse positivo explícito ("quero fazer um curso") nunca
 *    são declínio — guard prioritário.
 *  • A negação precisa estar adjacente ao verbo de inscrição/matrícula.
 *  • Frases condicionais ("se não tiver X, quero Y") e plano B
 *    ("ou administração predial") são explicitamente excluídas.
 *  • Removidas regras genéricas ("agora não", "deixa pra lá", "não" puro)
 *    que produziam falsos positivos. Esses casos ficam para o LLM ou
 *    decisão humana.
 */
export function messageExpressesEnrollmentDecline(text, historyMessages = []) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 6) return false

  // Mensagens muito curtas (1-2 tokens) sem verbo de inscrição não podem
  // ser desistência (ex.: "predial", "pediatria", "obrigado").
  if (t.split(/\s+/).filter(Boolean).length < 2 && !/\b(desisto|desistir|n[aã]o)\b/i.test(t)) {
    return false
  }

  // GUARD PRIORITÁRIO: interesse positivo claro em curso/matrícula sem
  // negação. Nunca pode virar declínio.
  if (hasInteressePositivoNoNeg(t)) return false

  // 1) Negação direta sobre verbo de inscrição/matrícula PRECEDE o guard
  // de confirmação ("não quero me inscrever" contém "quero me inscrever").
  if (NEGACAO_DIRETA_INSCRICAO_RE.test(t)) return true

  if (messageConfirmsProceedToInscricaoForm(text, historyMessages)) return false

  // Plano B / curso alternativo — não é desistência.
  if (PLANO_B_CURSO_RE.test(t)) return false

  // "se não tiver veterinária, quero pediatria" — condicional, não recusa.
  if (CONDICIONAL_NEGATIVO_RE.test(t)) {
    if (/\b(quero|prefiro|gostaria|desejo|tenho\s+interesse)\b/i.test(t)) {
      return false
    }
    // sem verbo positivo na cláusula, ainda pode ser declínio puro
    // ("se não der, deixa pra lá"); cai nos demais testes abaixo.
  }

  // 2) "não tenho interesse" / "sem interesse" PROXIMO de inscrição/matrícula/curso.
  // Como esses prefixos JÁ contêm a negação, "curso" pode entrar sem causar
  // falso positivo com "quero conhecer um curso".
  if (
    /\b(n[aã]o\s+tenho\s+interesse|sem\s+interesse|n[aã]o\s+me\s+interess[ao])\b[\s\S]{0,40}\b(inscri[cç][aã]o|matr[ií]cula|matricul|inscrever|seguir|curso)\b/i.test(
      t,
    )
  ) {
    return true
  }

  // 3) Verbo de desistência explícito.
  if (/\b(desistir|desist[eê]ncia|desisto|desisti)\b/i.test(t)) {
    if (/\b(inscri[cç][aã]o|matr[ií]cula|curso|sumar[eé])\b/i.test(t)) return true
    // "desisto" sozinho após pergunta de matrícula
    if (/^\s*desist[oe]\s*[.!?]*\s*$/i.test(t)) return true
  }

  return false
}

/** Assistente pediu explicitamente sobre inscrição/matrícula na última msg? */
function assistantAskedEnrollmentRecently(historyMessages = []) {
  const last = lastAssistantText(historyMessages) || ''
  if (!last) return false
  // Reaproveita o detector existente do scope; complementa com pergunta direta
  if (assistantAskedEnrollmentInLastReply(historyMessages)) return true
  return /\b(deseja\s+(seguir|prosseguir|fazer)\s+(com\s+a\s+)?(inscri[cç][aã]o|matr[ií]cula)|quer\s+(seguir|fazer)\s+a\s+(inscri[cç][aã]o|matr[ií]cula)|posso\s+te\s+ajudar\s+com\s+(a\s+)?(inscri[cç][aã]o|matr[ií]cula))\b/i.test(
    last,
  )
}

/** Lead confirmou a desistência após a pergunta canônica do agente. */
export function messageConfirmsFinalDesistencia(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim().replace(/[.!?]+$/, '')
  if (!t || t.length > 80) return false
  if (/^\s*(n[aã]o|nao)\s*$/i.test(t)) return true
  if (/\b(sim|confirmo|pode\s+encerrar|quero\s+desistir|desisto|desistir)\b/i.test(t)) {
    if (/\b(n[aã]o\s+quero\s+mais|desistir|desist[eê]ncia|encerrar)\b/i.test(t)) return true
    if (/^\s*(sim|confirmo|desisto)\s*$/i.test(t)) return true
    if (/\bsim\b/i.test(t) && /\bdesist/i.test(t)) return true
  }
  if (/\bn[aã]o\s+quero\s+mesmo\s+seguir\b/i.test(t)) return true
  if (/\bconfirmo\s+a\s+desist/i.test(t)) return true
  return false
}

/** Lead voltou atrás — quer seguir com inscrição ou outro curso. */
export function messageRevokesDesistencia(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t) return false
  if (messageConfirmsProceedToInscricaoForm(text, [])) return true
  if (/\b(mudei\s+de\s+ideia|quero\s+sim|quero\s+me\s+inscrever|quero\s+matricular)\b/i.test(t)) return true
  if (/\b(outro\s+curso|outra\s+gradua)\b/i.test(t) && /\b(quero|gostaria)\b/i.test(t)) return true
  if (/\bfalar\s+com\s+(um\s+)?consultor\b/i.test(t)) return true
  return false
}

export function buildConfirmDesistenciaReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Entendi${nameBit}. Você *não deseja mesmo seguir* com a inscrição neste momento?\n\n` +
    `Temos diversos cursos que podem impulsionar a sua carreira — se quiser conhecer outra opção, ` +
    `posso te ajudar por aqui. Se preferir falar com um consultor, estamos à disposição.\n\n` +
    `Caso queira *confirmar a desistência* da inscrição, responda por aqui (por exemplo: *sim* ou *confirmo a desistência*).`
  )
}

export function buildDesistenciaAgradecimentoReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Obrigado pelo contato${nameBit}! Registramos sua desistência da inscrição. ` +
    `Qualquer outra dúvida sobre os cursos da Faculdade Sumaré, é só entrar em contato conosco por aqui. ` +
    `Será um prazer ajudar quando quiser.`
  )
}

/**
 * Contexto mínimo para iniciar fluxo de desistência. Requisitos cumulativos:
 *  1. Houve engajamento sobre curso (assistente falou de curso + lead participou).
 *  2. Mensagem do lead expressa declínio (heurística rígida).
 *  3. O assistente perguntou recentemente sobre inscrição/matrícula — sem
 *     essa pergunta o "declínio" perde contexto e vira falso positivo.
 *  4. O assistente NÃO acabou de pedir confirmação de desistência (evita
 *     repetir; nesse caso o flow entra em `inConfirmStep`).
 */
export function shouldOfferDesistenciaConfirm(userMessage, historyMessages) {
  if (!conversationHadCourseEngagement(historyMessages)) return false
  if (!messageExpressesEnrollmentDecline(userMessage, historyMessages)) return false
  if (!assistantAskedEnrollmentRecently(historyMessages)) return false
  const lastAssist = lastAssistantText(historyMessages)
  if (assistantAskedDesistenciaConfirm(lastAssist)) return false
  return true
}
