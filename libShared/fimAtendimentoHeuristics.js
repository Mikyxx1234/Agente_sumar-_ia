/**
 * Lead solicita encerrar o atendimento (encerramento educado ou explícito).
 * Detectado antes do LLM; finalização grava sum_Motivo da perda = "Sem Interesse".
 */

import { normalizeMessageForScope } from './scopeHeuristics.js'
import {
  conversationHasActiveTopic,
  lastAssistantText,
  assistantAskedEnrollmentInLastReply,
} from './conversationContextHeuristics.js'
import { messageExpressesExplicitNoInterest } from './inscricaoDesistenciaHeuristics.js'

const POLITE_CLOSE_RE =
  /^\s*(muito\s+obrigad[oa]?|obrigad[oa]?|valeu|agrade[çc]o|brigad[ãa]o|obg)\s*[.!?]*\s*$/i

const SOFT_DECLINE_RE =
  /^\s*(n[aã]o,?\s+tranquil[oa]?|n[aã]o\s+tranquil[oa]?|sem\s+problema|de\s+boa|tudo\s+bem|t[aá]\s+bom)\s*[.!?]*\s*$/i

/** "Ok" isolado costuma ser reconhecimento, não recusa de atendimento. */
const ACK_ONLY_OK_RE = /^\s*ok\s*[.!?]*\s*$/i

const EXPLICIT_END_RE =
  /\b(encerrar|finalizar|fechar)\s+(o\s+)?(atendimento|conversa|chat)\b/i

function lastUserTexts(historyMessages = [], limit = 4) {
  const out = []
  for (let i = (historyMessages || []).length - 1; i >= 0 && out.length < limit; i--) {
    const m = historyMessages[i]
    const role = String(m?.role || '').toLowerCase()
    if (role === 'user' || role === 'lead') {
      const t = String(m?.content || '').trim()
      if (t) out.push(t)
    }
  }
  return out
}

function assistantRecentlyPushedEnrollment(historyMessages = []) {
  if (assistantAskedEnrollmentInLastReply(historyMessages)) return true
  const last = lastAssistantText(historyMessages) || ''
  return (
    /\b(quer\s+que\s+eu\s+te\s+ajude\s+com\s+(a\s+)?(matr[ií]cula|inscri[cç][aã]o)|posso\s+te\s+ajudar\s+com\s+(a\s+)?(matr[ií]cula|inscri[cç][aã]o)|deseja\s+seguir|outro\s+curso\s+ead)\b/i.test(
      last,
    ) ||
    /\b(se\s+precisar|se\s+mudar\s+de\s+ideia|outros\s+cursos)\b/i.test(last)
  )
}

function userRecentlyDeclinedOrClosed(historyMessages = []) {
  for (const t of lastUserTexts(historyMessages, 3)) {
    if (messageExpressesExplicitNoInterest(t)) return true
    if (SOFT_DECLINE_RE.test(normalizeMessageForScope(t))) return true
    if (POLITE_CLOSE_RE.test(normalizeMessageForScope(t))) return true
  }
  return false
}

/** Lead pediu encerramento ou fechou educadamente após recusa/encerramento implícito. */
export function messageExpressesEndOfServiceRequest(text, historyMessages = []) {
  const t = normalizeMessageForScope(text).toLowerCase().trim().replace(/[.!?]+$/, '')
  if (!t) return false

  if (!conversationHasActiveTopic(historyMessages)) return false

  if (messageExpressesExplicitNoInterest(text)) return true
  if (EXPLICIT_END_RE.test(t)) return true
  if (/\bn[aã]o\s+preciso\s+de\s+mais\s+nada\b/i.test(t)) return true

  if (ACK_ONLY_OK_RE.test(t)) {
    return (
      assistantRecentlyPushedEnrollment(historyMessages) &&
      userRecentlyDeclinedOrClosed(historyMessages)
    )
  }

  if (SOFT_DECLINE_RE.test(t)) return true

  if (POLITE_CLOSE_RE.test(t)) {
    return assistantRecentlyPushedEnrollment(historyMessages) || userRecentlyDeclinedOrClosed(historyMessages)
  }

  return false
}