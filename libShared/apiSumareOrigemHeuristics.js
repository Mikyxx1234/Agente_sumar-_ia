/**
 * Leads distribuídos pela API Sumaré (sum_Origem = "Api Sumaré") em estágios
 * avançados do funil Agente — inscrição ou aguardando pagamento.
 *
 * Abertura da conversa: salesbots Kommo (não a IA):
 *   - inscrição           → bot 49977
 *   - aguardando pagamento → bot 49979
 * A IA só entra após a mensagem do lead chegar no buffer (flush).
 */

import { normalizeCpf } from '../server/sumareCaptacaoClient.js'

const CPF_IN_TEXT_RX = /\b(\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}|\d{11})\b/

/** Salesbot Kommo — fila inscrição (Api Sumaré). */
export const API_SUMARE_SALESBOT_INSCRICAO_ID = 49977

/** Salesbot Kommo — fila aguardando pagamento (Api Sumaré). */
export const API_SUMARE_SALESBOT_PAGAMENTO_ID = 49979

export function isApiSumareAdvancedFunnelEnabled(env = process.env) {
  const raw = String(env?.API_SUMARE_ADVANCED_FUNNEL_ENABLED ?? 'true').trim().toLowerCase()
  return !['false', '0', 'no', 'off', ''].includes(raw)
}

export function normalizeOrigemText(val) {
  return String(val || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Aceita "Api Sumaré", "Api Sumare", variações de acento/espaço. */
export function isApiSumareOrigemValue(val) {
  const t = normalizeOrigemText(val)
  if (!t) return false
  if (t === 'api sumare' || t === 'api sumaré') return true
  return /\bapi\b/.test(t) && /\bsumar/.test(t)
}

export function isApiSumareOrigemSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false
  return isApiSumareOrigemValue(snapshot.origem)
}

export function extractCpfFromMessage(text) {
  const raw = String(text || '')
  const m = raw.match(CPF_IN_TEXT_RX)
  if (!m?.[1]) return ''
  return normalizeCpf(m[1])
}
