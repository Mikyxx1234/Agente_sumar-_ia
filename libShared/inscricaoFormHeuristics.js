/** Heurísticas do fluxo Form Sumar (template WhatsApp → salesbot pós-formulário). */

import { normalizeMessageForScope, messageLooksLikeOperationalChat } from './scopeHeuristics.js'

export const INSCRICAO_FORM_STATUS_AGUARDANDO = 'aguardando_form_sumar'
export const INSCRICAO_FORM_STATUS_CONCLUIDO = 'form_sumar_concluido'

/** Lead cobra o formulário que ainda não chegou. */
export function messageAsksForFormResend(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 5) return false
  return (
    /\b(cad[eê]|cadê|onde|sumiu|manda|envia|reenvi)\b[\s\S]{0,45}\bformul[aá]rio\b/i.test(t) ||
    /\bformul[aá]rio\b[\s\S]{0,30}\b(cad[eê]|cadê|onde|n[aã]o\s+chegou)\b/i.test(t) ||
    /\bn[aã]o\s+(recebi|chegou|veio)\b[\s\S]{0,30}\bformul[aá]rio\b/i.test(t)
  )
}

function recentAssistantText(historyMessages, max = 3) {
  return (historyMessages || [])
    .filter((m) => m.role === 'assistant')
    .slice(-max)
    .map((m) => String(m.content || ''))
    .join('\n')
    .toLowerCase()
}

/**
 * Lead quer iniciar / prosseguir inscrição ou matrícula (mensagem atual + contexto recente).
 * Inclui confirmações como "gostei e quero fazer esse curso" (sem palavra "matrícula").
 */
export function messageRequestsInscricaoForm(text, historyMessages = []) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  if (messageLooksLikeOperationalChat(text)) return false
  if (messageLooksLikeFormSumarResponse(text)) return false
  if (messageAsksForFormResend(text)) return false

  // Só informação sobre curso (valores, duração) — ainda não é inscrição
  if (
    /\b(valor|valores|pre[cç]o|mensalidade|dura[cç][aã]o|quanto\s+custa|grade)\b/i.test(t) &&
    !/\b(fazer|matricul|inscri|me\s+inscrever)\b/i.test(t)
  ) {
    return false
  }

  if (
    /\b(realizar|fazer|efetuar|concluir|continuar|prosseguir|seguir|avan[cç]ar|iniciar|come[cç]ar)\b[\s\S]{0,45}\b(inscri[cç][aã]o|cadastro|matr[ií]cula)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (
    /\b(quero|gostaria|preciso|posso|vou)\b[\s\S]{0,40}\b(me\s+inscrever|inscrever|matricular|realizar\s+a\s+inscri)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\b(quero|preciso|vou)\b[\s\S]{0,25}\b(matr[ií]cula|inscri[cç][aã]o)\b/i.test(t)) return true
  if (/\b(matr[ií]cula|inscri[cç][aã]o)\b[\s\S]{0,30}\b(agora|j[aá]|por\s+favor)\b/i.test(t)) return true

  // "quero fazer esse curso" / "gostei e quero fazer o curso"
  if (/\bquero\s+fazer\b/i.test(t) && /\b(curso|esse|essa)\b/i.test(t)) return true
  if (/\bgostei\b/i.test(t) && /\bquero\b/i.test(t) && /\b(fazer|curso)\b/i.test(t)) return true
  if (/\b(quero|vou)\s+(fazer|curso)\b/i.test(t) && /\bcurso\b/i.test(t)) return true

  const assist = recentAssistantText(historyMessages)
  if (assist && /\b(quer\s+seguir|matr[ií]cula|inscri[cç][aã]o|formul[aá]rio)\b/i.test(assist)) {
    if (/\b(sim|quero|pode|bora|vamos|ok|esse\s+curso|fazer|gostei)\b/i.test(t) && t.length < 80) return true
  }

  return false
}

/** Resposta do WhatsApp Flow / formulário "Form Sumar" após preenchimento. */
export function messageLooksLikeFormSumarResponse(text) {
  const raw = String(text || '').trim()
  if (!raw || raw.length < 4) return false
  const t = raw.toLowerCase()

  if (/\[formulario\s+sumar\]/i.test(raw)) return true
  if (/\bnfm_reply\b/i.test(t) || /\bresponse_json\b/i.test(t)) return true
  if (/^\s*[\{\[]/.test(raw) && /"(nome|name|email|e-mail|telefone|phone|cpf|curso)"/i.test(raw)) {
    return true
  }
  if (
    /\b(nome|e-?mail|telefone|cpf|curso|ingresso)\s*[:=]/i.test(raw) &&
    /\b(nome|e-?mail|telefone|cpf)\s*[:=]/i.test(raw)
  ) {
    return true
  }
  if (/\bformul[aá]rio\b/i.test(t) && /\b(preenchido|enviado|respondido|conclu[ií]do)\b/i.test(t)) return true
  return false
}

export function buildInscricaoFormSentReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Perfeito${nameBit}! Para dar continuidade à sua inscrição na Faculdade Sumaré, enviei o formulário ` +
    `"Form Sumar" aqui no WhatsApp. É rapidinho — preencha com seus dados básicos e, assim que enviar, ` +
    `nossa equipe segue com o próximo passo com você por aqui.`
  )
}

export function buildInscricaoFormCompleteReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  if (opts.ok) {
    return (
      `Obrigado${nameBit}! Recebemos o formulário e já encaminhamos seu cadastro para um consultor ` +
      `da Faculdade Sumaré finalizar sua inscrição — em breve alguém da equipe fala com você por aqui, tudo bem?`
    )
  }
  return (
    `Obrigado${nameBit}! Registramos o formulário. Um consultor da Faculdade Sumaré entrará em contato em breve para concluir sua inscrição.`
  )
}
