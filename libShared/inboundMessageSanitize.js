/**
 * Limpa texto inbound poluído pelo Kommo/WhatsApp (eco da própria IA com sufixo EX-…).
 */

import { normalizeMessageForScope } from './scopeHeuristics.js'

export const AGENT_OUTBOUND_SUFFIX = /\s-\sEX-\d{6}-\d{4}-\d{3}\s*$/i

const ASSISTANT_ECHO_START =
  /^(boa\s+(tarde|dia|noite)|ol[aá]!|perfeito!|desculpe|obrigado|salesbot\s+formulario)/i

/** Trecho é eco de mensagem enviada pelo agente (nota Kommo com EX-…). */
export function isLikelyAgentEcho(text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  if (AGENT_OUTBOUND_SUFFIX.test(raw)) return true
  if (/\s-\sEX-\d{6}-\d{4}-\d{3}\b/i.test(raw)) return true
  const low = raw.toLowerCase()
  if (low.includes('salesbot formulario_sum ativado')) return true
  if (low.includes('registramos o formulário')) return true
  if (ASSISTANT_ECHO_START.test(raw) && raw.length > 40) return true
  return false
}

/** Mensagem do lead pede preço/valores (não é confirmação de matrícula). */
export function messageAsksCoursePrice(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  if (!/\b(valor|valores|pre[cç]o|preços|mensalidade|quanto\s+custa|quanto\s+é|investimento|parcela)\b/i.test(t)) {
    return false
  }
  if (/\b(fazer|matricul|inscri|me\s+inscrever|envia(r)?\s+o\s+formul)/i.test(t)) return false
  return true
}

/**
 * Remove ecos da IA e mantém o que o lead realmente escreveu.
 * Kommo costuma concatenar: "texto do agente - EX-…, qual o valor do curso".
 */
export function sanitizeLeadInboundMessage(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  if (inboundLooksLikeContratoLinkEcho(raw)) return ''

  const parts = raw
    .split(/,(?=\s*(?:[A-Za-zÀ-ÿ0-9]|Salesbot|Boa|Olá|Perfeito|Desculpe))/)
    .map((p) => p.trim())
    .filter(Boolean)

  const leadParts = parts.filter((p) => !isLikelyAgentEcho(p))
  if (leadParts.length === 0) {
    const m = raw.match(
      /\b(qual\s+o\s+valor[^,?]*|quanto\s+custa[^,?]*|valores?\s+do\s+curso[^,?]*|pre[cç]o\s+do\s+curso[^,?]*)/i,
    )
    if (m?.[0]) return m[0].trim()
    return raw.replace(/\s-\sEX-\d{6}-\d{4}-\d{3}\b/gi, ' ').replace(/\s+/g, ' ').trim()
  }

  const joined = leadParts.join(' ').replace(/\s+/g, ' ').trim()
  return joined.length >= 3 ? joined : raw
}

/** Texto típico de nota/sistema Kommo (salesbot, integração) — nunca é fala do lead. */
/** Nota interna Kommo sobre captação/contrato — nunca é fala do lead. */
export function isKommoCaptacaoContratoSystemNote(text) {
  const low = String(text || '').toLowerCase()
  if (!low) return false
  if (/\binscri[cç][aã]o sumar[eé]\b/i.test(low) && /\b(candidato|link contrato|contrato)\b/i.test(low)) {
    return true
  }
  if (/\blink contrato enviado\b/i.test(low)) return true
  if (/\bsumar[eé]\.edu\.br\b/i.test(low) && /\bcontrato\b/i.test(low) && /\b(candidato|id=)\b/i.test(low)) {
    return true
  }
  return false
}

export function isKommoSystemOrIntegrationNote(text) {
  const low = String(text || '').toLowerCase()
  if (!low) return false
  // Sinal do Meta/Kommo de Flow preenchido — deve acionar pós-form, não ser descartado.
  if (/\bflow\s+responses\s+received\b/i.test(low)) return false
  if (/\brespostas\s+recebidas\s+(no\s+)?flow\b/i.test(low)) return false
  if (isKommoCaptacaoContratoSystemNote(text)) return true
  if (/\bsalesbot\b/i.test(low)) return true
  if (/\bformulario_sum\b/i.test(low)) return true
  if (/\binscri[cç][aã]o via agente ia\b/i.test(low)) return true
  if (/\bnome da integra[cç][aã]o\b/i.test(low)) return true
  if (/\bintegra[cç][aã]o\b/i.test(low) && /\bwhatsapp\b/i.test(low)) return true
  return false
}

/** Eco de link de contrato (outbound ou nota CRM) — não tratar como mensagem do candidato. */
export function inboundLooksLikeContratoLinkEcho(text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  if (isKommoCaptacaoContratoSystemNote(raw)) return true
  const low = raw.toLowerCase()
  if (/\bsumar[eé]\.edu\.br\b/i.test(low) && /\bcontrato\b/i.test(low) && /\bid=\d{8,}/i.test(low)) {
    return true
  }
  if (/\blink contrato enviado\b/i.test(low)) return true
  return false
}

/** Bloqueia disparo de formulário quando o texto é eco do agente misturado com frase de inscrição. */
export function inboundLooksLikeAgentEchoOnly(text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  const exCount = (raw.match(/\s-\sEX-\d{6}-\d{4}-\d{3}\b/gi) || []).length
  if (exCount >= 1 && isLikelyAgentEcho(raw.split(/,(?=\s)/)[0] || raw)) return true
  const sanitized = sanitizeLeadInboundMessage(raw)
  if (sanitized !== raw && sanitized.length < 12 && exCount >= 1) return true
  return false
}
