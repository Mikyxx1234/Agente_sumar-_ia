/**
 * Assuntos acadêmicos pós-matrícula (trancamento, cancelamento, ex-aluno, etc.)
 * → direcionamento aos canais oficiais (Portal do Aluno / atendimento / ouvidoria).
 */

import {
  SUMARE_ATENDIMENTO_URL,
  SUMARE_OUVIDORIA_URL,
  messageConfirmsChannelExit,
  assistantAskedExitChannelConfirm,
} from './humanHandoffHeuristics.js'
import { messageRequestsHuman, messageStrongHumanEscalation } from './scopeHeuristics.js'
import { lastAssistantText } from './conversationContextHeuristics.js'

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

/** Nova captação / inscrição comercial — não é assunto acadêmico institucional. */
function looksLikeCommercialEnrollment(t) {
  if (/\b(quero|gostaria|posso|como)\s+(me\s+)?(matricular|inscrever|fazer\s+(a\s+)?inscri)/i.test(t)) return true
  if (/\b(valor|pre[cç]o|mensalidade|bolsa|desconto)\b/i.test(t) && !/\b(atrasad|inadimpl|d[eé]bito)/i.test(t)) return true
  if (/\b(transfer[eê]ncia|aproveitamento\s+de\s+mat[eé]rias?|dispensa\s+de\s+(mat[eé]rias?|disciplinas?))\b/i.test(t)) return true
  // Histórico/comprovante/documentos NO CONTEXTO de transferência/aproveitamento/dispensa
  // são pedido de entrega de documentação de ingresso (comercial), não atendimento
  // acadêmico de aluno já matriculado. Ítrio #24133683: "não querem meu histórico,
  // comprovante de matrícula para a dispensa de disciplinas?".
  if (
    /\b(hist[oó]rico|comprovante|documentos?)\b/i.test(t) &&
    /\b(transfer[eê]ncia|aproveitamento|dispensa)\b/i.test(t)
  ) {
    return true
  }
  // "Já sou formado e queria saber o tempo/curso…" = interesse comercial (nova/2ª graduação),
  // não pedido de secretaria/ex-aluno. Clayton #24121727: falso positivo em "formado".
  if (
    /\b(j[aá]\s+sou\s+formado|sou\s+formado|segunda\s+gradua[cç][aã]o|2[aª]\s+gradua[cç][aã]o)\b/i.test(t) &&
    /\b(cursar|curso|tempo|dura[cç][aã]o|quero|queria|gostaria|saber|matricular|inscrever|estudar|gradua)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\b(tempo|dura[cç][aã]o|semestres?)\b/i.test(t) && /\b(cursar|curso|gradua|faculdade|estudar)\b/i.test(t)) {
    return true
  }
  if (/\b(queria|quero|gostaria)\s+saber\b/i.test(t) && /\b(curso|cursar|gradua|mensalidade|valor)\b/i.test(t)) {
    return true
  }
  return false
}

/** Padrões de assunto acadêmico na mensagem isolada. */
export function messageAsksAcademicAffairsSupportInText(text) {
  const t = normalize(text)
  if (!t || t.length < 4) return false
  if (looksLikeCommercialEnrollment(t)) return false

  if (/\b(trancar|trancamento|trancar\s+(o\s+)?curso|trancar\s+(a\s+)?matr[ií]cula)\b/i.test(t)) return true
  if (/\b(cancelar|cancelamento)\s+(a\s+)?(matr[ií]cula|curso|inscri[cç][aã]o)\b/i.test(t)) return true
  if (/\b(cancelar|cancelamento)\b/i.test(t) && /\b(matricula|curso)\b/i.test(t)) return true
  // Ex-aluno institucional / conclusão de curso. NÃO usar "formado" isolado —
  // "já sou formado e quero cursar X" é captação (veja looksLikeCommercialEnrollment).
  if (/\b(ex[-\s]?aluno|j[aá]\s+(fui|era)\s+aluno)\b/i.test(t)) return true
  if (/\b(j[aá]\s+conclu[ií]|j[aá]\s+finalizei)\b/i.test(t) && !/\b(quero|queria|gostaria|cursar|curso)\b/i.test(t)) {
    return true
  }
  if (/\bformado\b/i.test(t) && !/\b(quero|queria|gostaria|cursar|curso|tempo|dura|saber|estudar)\b/i.test(t)) {
    return true
  }
  if (/\b(situa[cç][aã]o\s+acad[eê]mica|secretaria\s+acad[eê]mica|coordena[cç][aã]o\s+do\s+curso)\b/i.test(t)) return true
  if (/\b(hist[oó]rico\s+escolar|hist[oó]rico\s+de\s+notas|declara[cç][aã]o\s+de\s+matr[ií]cula)\b/i.test(t)) return true
  if (/\bsegunda\s+via\b/i.test(t) && /\b(documento|diploma|certificado|hist[oó]rico)\b/i.test(t)) return true
  if (/\b(cola[cç][aã]o\s+de\s+grau|jubilamento|abandono\s+de\s+curso)\b/i.test(t)) return true
  if (/\b(portal\s+do\s+aluno|acesso\s+ao\s+portal)\b/i.test(t) && /\b(problema|senha|acesso|solicitar|pedido)\b/i.test(t)) return true
  if (/\b(inadimpl|mensalidade[s]?\s+atrasad|d[eé]bito\s+em\s+aberto|negativad)/i.test(t)) return true
  if (/\b(reclama[cç][aã]o|protocolo)\b/i.test(t) && /\b(acad[eê]mica|matr[ií]cula|curso|faculdade)\b/i.test(t)) return true
  if (/\bemitir\s+(o\s+)?diploma\b/i.test(t) || /\b(retirada\s+do\s+diploma)\b/i.test(t)) return true
  if (/\bdiploma\b/i.test(t)) return true
  if (/\bsolicita[cç][aã]o\s+de\s+diploma\b/i.test(t)) return true

  return false
}

/** Histórico recente menciona assunto acadêmico institucional (diploma, trancamento, etc.). */
export function historyHasAcademicAffairsTopic(historyMessages = [], limit = 12) {
  if (!Array.isArray(historyMessages)) return false
  return historyMessages
    .slice(-limit)
    .some((m) => messageAsksAcademicAffairsSupportInText(String(m?.content || '')))
}

/** Follow-up sobre consultor ligar após pedido acadêmico (ex.: "Ele vai ligar?"). */
function messageAsksConsultantCallFollowUp(text) {
  const t = normalize(text)
  if (!t || t.length < 4) return false
  if (/\b(vai|v[aã]o)\s+ligar\b/i.test(t)) return true
  if (/\bquando\s+(me\s+)?ligam\b/i.test(t)) return true
  if (/\b(meu\s+)?consultor\b/i.test(t) && /\b(ligar|ligar[aã]o|contato|telefon)\b/i.test(t)) return true
  return false
}

function recentUserMessages(historyMessages, limit = 8) {
  if (!Array.isArray(historyMessages)) return []
  return historyMessages
    .filter((m) => m?.role === 'user')
    .slice(-limit)
    .map((m) => String(m.content || ''))
}

/**
 * Lead pede suporte acadêmico institucional (trancamento, cancelamento de matrícula
 * já ativa, ex-aluno, documentos escolares, etc.) — ou follow-up após pedido recente.
 */
export function messageAsksAcademicAffairsSupport(text, historyMessages = []) {
  if (messageAsksAcademicAffairsSupportInText(text)) return true
  if (messageAsksConsultantCallFollowUp(text)) {
    const recent = [...recentUserMessages(historyMessages), text]
    if (recent.some((msg) => messageAsksAcademicAffairsSupportInText(msg))) return true
  }
  if (!historyHasAcademicAffairsTopic(historyMessages)) return false
  if (messageStrongHumanEscalation(text) || messageRequestsHuman(text)) return true
  if (
    messageConfirmsChannelExit(text) &&
    assistantAskedExitChannelConfirm(lastAssistantText(historyMessages))
  ) {
    return true
  }
  return false
}

function firstName(nome) {
  const raw = String(nome || '').trim()
  if (!raw) return ''
  const first = raw.split(/\s+/)[0]
  if (!first || /\d/.test(first) || first.length < 2) return ''
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

/** Mensagem canônica de direcionamento acadêmico. */
export function buildAcademicAffairsRedirectReply(opts = {}) {
  const name = firstName(opts.pushName)
  const ola = name ? `Olá, ${name}! Tudo bem?` : 'Olá! Tudo bem?'

  return (
    `${ola}\n\n` +
    `Para solicitações de *atendimento acadêmico*, o direcionamento correto depende da sua situação:\n\n` +
    `✅ *Alunos com matrícula ativa:*\n` +
    `O atendimento deve ser solicitado diretamente pelo *Portal do Aluno*, no setor responsável.\n\n` +
    `✅ *Ex-alunos, dúvidas gerais, cancelamento ou trancamento de matrícula:*\n` +
    `O atendimento deve ser feito pelo canal oficial da instituição:\n` +
    `${SUMARE_ATENDIMENTO_URL}\n\n` +
    `✅ *Ouvidoria:*\n` +
    `Caso deseje registrar uma manifestação, sugestão, reclamação ou acompanhamento pela Ouvidoria, acesse:\n` +
    `${SUMARE_OUVIDORIA_URL}\n\n` +
    `Reforçamos que dúvidas de *ex-alunos*, *cancelamento* ou *trancamento de matrícula* devem ser tratadas exclusivamente por um dos canais oficiais acima.\n\n` +
    `Estamos à disposição para orientar sobre o canal correto de atendimento.`
  )
}
