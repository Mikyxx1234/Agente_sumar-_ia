/** Lead pede aprofundamento sobre o curso (não só preço). */

import { normalizeMessageForScope } from './scopeHeuristics.js'

const MORE_INFO_RE =
  /\b(mais\s+detalhes?|mais\s+informa[cç][õo]es?|quero\s+saber\s+mais|me\s+(fale|diga|conte|passa|envie)\s+mais|gostaria\s+de\s+saber\s+mais|informa[cç][õo]es?\s+sobre\s+o\s+curso|falar\s+mais\s+sobre|conte\s+mais\s+sobre|detalhes?\s+do\s+curso|como\s+[eé]\s+o\s+curso|sobre\s+o\s+que\s+[eé]\s+o\s+curso)\b/i

const VAGUE_MORE_RE =
  /^(mais\s+detalhes?|mais\s+informa[cç][õo]es?|quero\s+mais|me\s+d[eê]\s+mais)\s*[.!?]*$/i

export function userAsksCourseMoreDetails(text) {
  const t = normalizeMessageForScope(text)
  if (!t || t.length < 4) return false
  if (MORE_INFO_RE.test(t)) return true
  if (VAGUE_MORE_RE.test(t.trim())) return true
  return false
}

export const COURSE_MORE_INFO_REPLY_RULES = [
  'PEDIDO DE MAIS INFORMAÇÕES SOBRE O CURSO: quando o lead pedir mais detalhes/informações sobre um curso já em pauta, responda com um resumo objetivo em texto corrido ou bullets curtos, SEM repetir literalmente a mensagem anterior.',
  'O resumo DEVE incluir, quando existirem no CONTEXT (bloco PERFIL DO CURSO ou trechos equivalentes): (1) área de interesse / sobre o curso; (2) áreas de trabalho ou mercado; (3) funções ou atuações típicas; (4) modalidade e duração; (5) mensalidade com desconto e preço cheio se estiverem no CONTEXT.',
  'Se o CONTEXT tiver [PERFIL DO CURSO] para o curso em pauta, use esses campos — não invente áreas, empregos ou funções que não estejam no CONTEXT.',
  'Se faltar PERFIL no CONTEXT, informe duração/modalidade/preço disponíveis e ofereça consultor (distribuir_humano) para grade ou detalhes que não constem na base.',
  'Não encerre só com "quer saber sobre matrícula?" sem antes entregar o resumo pedido.',
].join('\n')
