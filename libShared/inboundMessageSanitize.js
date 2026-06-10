/**
 * Limpa texto inbound poluído pelo Kommo/WhatsApp (eco da própria IA com sufixo EX-…).
 */

import { normalizeMessageForScope } from './scopeHeuristics.js'
import { extractCursoAreaFromText } from './cursoConfirmation.js'

export const AGENT_OUTBOUND_SUFFIX = /\s-\sEX-\d{6}-\d{4}-\d{3}-[a-z0-9]{4}\s*$/i

/**
 * Marcador estável injetado em TODA nota interna de auditoria criada pelo
 * agente (`createLeadAuditNote`). O poll de inbound (kommoInboundPoll) usa
 * este marcador para excluir essas notas de forma definitiva — sem depender
 * de casar o texto da nota frase a frase.
 *
 * É discreto o suficiente para o operador no CRM e nunca aparece em mensagem
 * real de candidato.
 */
export const AGENT_AUDIT_NOTE_MARKER = '· [registro interno IA]'

/** Regex tolerante: aceita o marcador com ou sem o "·" e espaçamento variável. */
const AGENT_AUDIT_NOTE_MARKER_RE = /\[registro\s+interno\s+ia\]/i

/**
 * Detecta nota interna de auditoria do agente (movimentação de funil, motivo
 * de perda, comprovante recebido, etc.). NUNCA é fala do candidato.
 *
 * Camada A: marcador explícito `[registro interno IA]` — blindagem definitiva
 *   para notas criadas via `createLeadAuditNote`.
 * Camada B: frases conhecidas de auditoria já existentes no CRM (defesa em
 *   profundidade para notas antigas sem o marcador).
 */
export function isAgentInternalAuditNote(text) {
  const raw = String(text || '')
  if (!raw.trim()) return false
  // Camada A — marcador explícito.
  if (AGENT_AUDIT_NOTE_MARKER_RE.test(raw)) return true

  // Camada B — frases de auditoria conhecidas.
  const low = raw.toLowerCase()
  if (/\blead\s+confirmou\s+desist[eê]ncia\b/i.test(low)) return true
  if (/\bmotivo\s+da\s+perda\b/i.test(low)) return true
  if (/\bcomprovante\s+de\s+pagamento\s+recebido\b/i.test(low)) return true
  if (/\blead\s+movido\s+para\s+(a\s+)?fila\b/i.test(low)) return true
  if (/\bmovido\s+para\s+(a\s+)?fila\s+\d+\b/i.test(low)) return true
  if (/\bmovido\s+para\s+(o\s+)?pipeline\b/i.test(low)) return true
  if (/\bap[oó]s\s+inatividade\b/i.test(low) && /\b(movido|fila|reativa)\b/i.test(low)) return true
  if (/\bfila\s+p[oó]s-?matr[ií]cula\b/i.test(low)) return true
  return false
}

const ASSISTANT_ECHO_START =
  /^(boa\s+(tarde|dia|noite)|ol[aá]!|perfeito!|desculpe|obrigado|salesbot\s+formulario)/i

/** Trecho é eco de mensagem enviada pelo agente (nota Kommo com EX-…). */
export function isLikelyAgentEcho(text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  if (AGENT_OUTBOUND_SUFFIX.test(raw)) return true
  if (/\s-\sEX-\d{6}-\d{4}-\d{3}-[a-z0-9]{4}\b/i.test(raw)) return true
  const low = raw.toLowerCase()
  if (low.includes('salesbot formulario_sum ativado')) return true
  if (low.includes('registramos o formulário')) return true
  if (/\b(quer que eu envie|sou o assistente|grade curricular em pdf|posso te ajudar com mais alguma)\b/i.test(low)) {
    return true
  }
  if (ASSISTANT_ECHO_START.test(raw) && raw.length > 40) return true
  return false
}

/**
 * Kommo costuma concatenar a última resposta do agente (com sufixo EX-…) com a fala do lead.
 * Retorna só o texto do lead após o último marcador EX-.
 */
export function extractLeadTextAfterAgentEcho(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const re = /\s-\sEX-\d{6}-\d{4}-\d{3}-[a-z0-9]{4}\b/gi
  let lastEnd = -1
  let m
  while ((m = re.exec(raw)) !== null) {
    lastEnd = m.index + m[0].length
  }
  if (lastEnd >= 0) {
    const after = raw.slice(lastEnd).replace(/^[,\s:;]+/, '').trim()
    if (after.length >= 2) return after
  }
  return raw
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
 * Mensagem do lead pergunta sobre FORMA/DATAS de pagamento da mensalidade
 * (quando pagar, dia de vencimento, como pagar, desconto por pagamento antecipado).
 * Deve ser respondida com o plano de pagamento da base — nunca encaminhar a consultor só por isso.
 */
export function messageAsksPaymentInfo(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  if (
    /\b(datas?\s+(de\s+|para\s+|pra\s+)?pagamento|forma\s+de\s+pagamento|como\s+(eu\s+)?pago|como\s+pagar|quando\s+(eu\s+)?(pago|pagar|vence)|quais?\s+dias?\s+(posso\s+)?pagar|dias?\s+(de\s+|para\s+|pra\s+)?(pagar|pagamento|vencimento)|vencimento|venc\w*|pagamento\s+antecipado|pagar\s+antecipad|desconto\s+(por\s+|no\s+)?pagamento|pag(ar|amento)\s+no\s+prazo|pagar\s+no\s+prazo|no\s+primeiro\s+dia|1\s*[°ºoª]?\s*dia\s+do\s+m[eê]s|todas\s+se\s+eu\s+pag)\b/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/**
 * Lead pergunta sobre taxa de matrícula institucional (não dado cadastral de terceiros).
 */
export function messageAsksTaxaMatriculaInstitucional(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  return /\b(tem\s+matr[ií]cula|taxa\s+de\s+matr[ií]cula|valor\s+da\s+matr[ií]cula|custo\s+da\s+matr[ií]cula|quanto\s+[ée]\s+a\s+matr[ií]cula|tem\s+taxa\s+de\s+matr[ií]cula|paga\s+matr[ií]cula)\b/i.test(
    t,
  )
}

/**
 * Lead pergunta quais polos EAD atendemos / polo mais próximo — listar os 5 polos cadastrados neste canal.
 */
export function messageAsksPoloAttendimentoList(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  if (
    /\b(polo\s+mais\s+pr[oó]ximo|mais\s+pr[oó]ximo.{0,40}(polo|casa)|qual\s+p[oó]lo|tem\s+p[oó]lo|existe\s+p[oó]lo|ir\s+(a[o]?|no)\s+p[oó]lo|atendimento\s+no\s+p[oó]lo|polos?\s+de\s+atendimento|unidades?\s+de\s+atendimento|precisar\s+ir\s+algum\s+p[oó]lo)\b/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/**
 * Lead pergunta contato/endereço do campus, central ou unidade presencial.
 */
export function messageAsksCampusOrPhoneContact(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  return /\b(campus|zcampis|unidade|central|telefone|whatsapp|falar\s+(no|com|na)|contato\s+(do|da|com|no)|ligar\s+(no|para|na))\b/i.test(
    t,
  )
}

/**
 * Lead pergunta sobre aulas presenciais / Central semipresencial (não confundir com lista de polos EAD).
 */
export function messageAsksSemipresencialCentral(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  if (messageAsksPoloAttendimentoList(text)) return false
  if (messageAsksCampusOrPhoneContact(text)) return true
  if (
    /\b(aulas?\s+presenciais?|atendimento\s+presencial|central\s+(em\s+)?pinheiros|semipresencial|onde\s+fica.{0,40}(aula|presencial)|rua\s+alegrete|ir\s+presencialmente|me\s+deslocar)\b/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/**
 * Lead pergunta onde fica polo/unidade/endereço para atendimento ou aulas presenciais.
 */
export function messageAsksLocationInfo(text) {
  return messageAsksPoloAttendimentoList(text) || messageAsksSemipresencialCentral(text)
}

/**
 * Lead pergunta sobre modalidade (EAD/online/distância), MEC ou preferência por estudo a distância.
 */
export function messageAsksModalidadeMecOrDistancia(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  if (/\b(mec)\b/i.test(t) && /\b(online|100\s*%|dist[aâ]ncia|presencial|ead)\b/i.test(t)) return true
  if (
    /\b(100\s*%\s*online|a\s+dist[aâ]ncia|dist[aâ]ncia|semipresencial|modalidade|prefiro\s+(a\s+)?dist[aâ]ncia|curso\s+online)\b/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/**
 * Lead pede informações gerais sobre um curso (valores, como fazer/matricular) — não é pedido de humano.
 */
export function messageAsksCourseInquiry(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 8) return false
  const hasCurso = Boolean(extractCursoAreaFromText(text)) || /\b(curso\s+de|curso\s+online)\b/i.test(t)
  if (!hasCurso) {
    if (!/\b(informa[cç][oõ]es?\s+sobre\s+o\s+curso|valores?\s+e\s+como)\b/i.test(t)) return false
  }
  if (
    /\b(informa[cç]|valor|valores|pre[cç]o|mensalidade|como\s+fazer|matr[ií]cula|inscri|quero\s+saber|d[uú]vida)\b/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/**
 * Lead pergunta grade curricular / disciplinas / o que vai aprender.
 */
export function messageAsksGradeCurricular(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 6) return false
  return /\b(grade\s+curricular|grade\s+do\s+curso|matriz\s+curricular|ementa|o\s+que\s+vou\s+aprender|o\s+que\s+voce\s+vai\s+aprender|quais\s+(materias|matérias|disciplinas)|disciplinas\s+do\s+curso|lista\s+de\s+(materias|matérias|disciplinas)|conteudo\s+do\s+curso|conteúdo\s+do\s+curso)\b/i.test(
    t,
  )
}

/** Lead pede PDF/arquivo/anexo da grade curricular (somente intenção do lead, sem eco do agente). */
export function messageAsksGradePdf(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  if (messageAsksCampusOrPhoneContact(t)) return false
  if (/\b(pdf|arquivo|anexo|documento)\b/i.test(t) && /\b(grade|curricular|disciplin|materia|matéria|ementa)\b/i.test(t)) {
    return true
  }
  if (/\b(manda|envia|envie|mande|me\s+manda|me\s+envia|quero\s+o\s+pdf|preciso\s+do\s+pdf|grade\s+em\s+pdf|pdf\s+da\s+grade)\b/i.test(t)) {
    return true
  }
  if (
    /\b(lnk|link)\b/i.test(t) &&
    /\b(passar|manda|envia|envie|mande|quero|preciso|me\s+manda|me\s+passa)\b/i.test(t) &&
    !/\b(campus|telefone|whatsapp|falar\s+no|contato)\b/i.test(t)
  ) {
    return true
  }
  return false
}

/**
 * Lead pergunta sobre promoção de Pós-Graduação 100% gratuita ao final da graduação.
 */
export function messageAsksPosGratisPromocao(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  return /\b(p[oó]s\s*(100%|gr[aá]tis|gratuita)|p[oó]s-gradua[cç][aã]o\s*(100%|gr[aá]tis|gratuita)|mais\s+uma\s+p[oó]s|ganhar\s+(uma\s+)?p[oó]s|promo[cç][aã]o\s+(da\s+)?p[oó]s|p[oó]s\s+gr[aá]t\w*\s+ao\s+final|passaram.*p[oó]s.*gr[aá]t|p[oó]s\s+100%\s+gr[aá]t)\b/i.test(
    t,
  )
}

/**
 * Lead quer contato com a Ouvidoria (reclamação formal, sugestão, elogio institucional).
 */
export function messageAsksOuvidoria(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 4) return false
  return /\b(ouvidoria|canal\s+de\s+ouvidoria|falar\s+com\s+a\s+ouvidoria|contato\s+com\s+a\s+ouvidoria|reclama[cç][aã]o\s+formal|protocolo\s+de\s+reclama)\b/i.test(
    t,
  )
}

/**
 * Remove ecos da IA e mantém o que o lead realmente escreveu.
 * Kommo costuma concatenar: "texto do agente - EX-…, qual o valor do curso".
 */
export function sanitizeLeadInboundMessage(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  if (inboundLooksLikeContratoLinkEcho(raw)) return ''

  const afterEcho = extractLeadTextAfterAgentEcho(raw)
  const work = afterEcho !== raw ? afterEcho : raw

  const parts = work
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
  // Nota interna de auditoria do agente (marcador + frases conhecidas).
  if (isAgentInternalAuditNote(text)) return true
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
