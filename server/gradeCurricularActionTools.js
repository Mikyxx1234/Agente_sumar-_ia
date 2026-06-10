/**
 * Tool de ação: enviar grade curricular em PDF via WhatsApp.
 */
import { fetchDadosClienteByTelefone, getLeadIdByTelefone } from './dadosClienteStore.js'
import { findLeadByPhone } from './kommoClient.js'
import { sendGradePdfToLead } from './evolution/evolutionSendMedia.js'
import { extractDiscussedCourseFromHistory } from '../libShared/conversationContextHeuristics.js'
import { extractCursoAreaFromText } from '../libShared/cursoConfirmation.js'
import {
  buildGradePdfIntroText,
  firstName,
  resolveGradeForPdf,
  listGradeGrausForCurso,
} from '../libShared/gradeCurricularPdfService.js'
import {
  messageAsksGradePdf,
  messageAsksGradeCurricular,
  messageAsksCoursePrice,
  messageAsksPaymentInfo,
  messageAsksCourseInquiry,
  messageAsksOtherTopicBesidesGrade,
  stripAgentEchoClauses,
  extractLeadTextAfterAgentEcho,
  sanitizeLeadInboundMessage,
  messageAsksCampusOrPhoneContact,
  messageAsksLocationInfo,
} from '../libShared/inboundMessageSanitize.js'

function detectNivel({ curso, userMessage, kommoCurso, kommoModalidade }) {
  const blob = `${curso} ${userMessage || ''} ${kommoCurso || ''}`.toLowerCase()
  if (/\b(p[oó]s|mba|especializa|lato\s+sensu)\b/i.test(blob)) return 'pos'
  if (/\b(gradua|bacharel|licenciatura|tecn[oó]log)\b/i.test(blob)) return 'grad'
  if (kommoModalidade && /h[ií]brido/i.test(String(kommoModalidade))) return 'pos'
  return null
}

async function resolveLeadId(env, telefone, hint) {
  if (Number.isFinite(Number(hint)) && Number(hint) > 0) return Number(hint)
  const fromDb = await getLeadIdByTelefone(env, telefone)
  if (fromDb != null) return Number(fromDb) || fromDb
  try {
    const lookup = await findLeadByPhone(env, telefone)
    if (lookup.ok && lookup.lead?.id) return Number(lookup.lead.id)
  } catch {
    /* ignore */
  }
  return null
}

function resolveCursoFromContext({ cursoArg, userMessage, historyMessages, kommoCurso }) {
  return (
    String(cursoArg || '').trim() ||
    extractDiscussedCourseFromHistory(historyMessages || []) ||
    extractCursoAreaFromText(userMessage || '') ||
    String(kommoCurso || '').trim() ||
    ''
  )
}

function grauFromText(text) {
  const t = String(text || '').toLowerCase()
  if (/\blicenciatura\b|\blicenciat\w*\b/.test(t)) return 'licenciatura'
  if (/\bbacharel\w*\b/.test(t)) return 'bacharelado'
  return null
}

const OTHER_GRAU = { licenciatura: 'bacharelado', bacharelado: 'licenciatura' }

/**
 * Detecta o grau que o lead REALMENTE quer (bacharelado/licenciatura).
 * Ordem importa:
 *  1) CORREÇÃO — quando o lead descreve a grade RECEBIDA como errada
 *     ("essa grade é do bacharelado", "não é licenciatura", "mandou bacharelado")
 *     → quer o grau OPOSTO ao citado.
 *  2) DESEJO POSITIVO — "queria a licenciatura", "grade de ... licenciatura".
 *  3) Menção simples a um grau.
 */
function detectGrauWanted(text) {
  const t = String(text || '').toLowerCase()
  if (!grauFromText(t)) return null

  const correcaoMatch =
    t.match(/\b(essa|est[ae]|a)\s+(grade\s+)?(é|e|esta|está|veio|foi|chegou|t[áa])\s+(do|de|da|o|a)?\s*(bacharel\w*|licenciat\w*)/) ||
    t.match(/\b(mandou|mandaram|enviou|enviaram|veio|recebi|me\s+mandou)\b[^.?!]*\b(bacharel\w*|licenciat\w*)/) ||
    t.match(/\bn[ãa]o\s+(é|e|seria|era)\s+(a\s+|o\s+|de\s+|do\s+|da\s+)?(bacharel\w*|licenciat\w*)/)
  if (correcaoMatch) {
    const citado = grauFromText(correcaoMatch[0])
    if (citado) return OTHER_GRAU[citado]
  }

  const wantMatch = t.match(
    /\b(quero|queria|prefiro|gostaria|preciso|seria|sou\s+d[ao]|fa[çc]o|curso|grade|a\s+de|me\s+(manda|envia|mande))\b[^.?!]*?\b(bacharel\w*|licenciat\w*)\b/,
  )
  if (wantMatch) return grauFromText(wantMatch[0])

  return grauFromText(t)
}

/** Remove qualquer grau existente do nome do curso e aplica o desejado. */
function applyGrauToCurso(curso, grau) {
  const base = String(curso || '')
    .replace(/\b(bacharelado|bacharel\w*|licenciatura|licenciat\w*|tecn[oó]log\w*)\b/gi, '')
    .replace(/\s*-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return grau ? `${base} ${grau}` : base
}

/**
 * @param {Record<string,string>} env
 * @param {object} args
 * @param {object} flowCtx
 */
export async function runEnviarGradePdf(env, args, flowCtx = {}) {
  const telefone = String(args?.telefone || flowCtx.telefone || '').trim()
  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Telefone ausente.',
      replyOverride: null,
    }
  }

  const rowDb = await fetchDadosClienteByTelefone(env, telefone, 'kommo_curso,kommo_modalidade,kommo_nome')
  const curso = resolveCursoFromContext({
    cursoArg: args?.curso,
    userMessage: flowCtx.userMessage,
    historyMessages: flowCtx.historyMessages,
    kommoCurso: rowDb?.kommo_curso,
  })
  if (!curso) {
    return {
      ok: false,
      code: 'MISSING_CURSO',
      text: 'Curso não identificado — peça ao lead qual curso.',
      replyOverride:
        'Para te enviar a grade em PDF, me confirma por favor o *nome do curso* e se é *graduação* ou *pós-graduação*?',
    }
  }

  const modalidade = args?.modalidade || rowDb?.kommo_modalidade || null
  const nivel = args?.nivel || detectNivel({
    curso,
    userMessage: flowCtx.userMessage,
    kommoCurso: rowDb?.kommo_curso,
    kommoModalidade: rowDb?.kommo_modalidade,
  })

  // Grau-aware: cursos como Educação Física têm Bacharelado E Licenciatura, com
  // grades DIFERENTES. Sem o grau, findGradeRow cai no primeiro match (Bacharelado).
  // Detecta o grau desejado (inclusive correções "essa é do bacharelado") e,
  // quando o curso tem 2 graus e não dá pra saber qual, pergunta ao lead.
  let grauWanted = detectGrauWanted(flowCtx.userMessage)
  if (!grauWanted) grauWanted = grauFromText(`${args?.curso || ''} ${curso}`)
  if (!grauWanted) {
    const histLeadText = (flowCtx.historyMessages || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'lead'))
      .map((m) => (typeof m?.content === 'string' ? m.content : ''))
      .join(' ')
    grauWanted = grauFromText(histLeadText)
  }

  let cursoFinal = curso
  const grausDisponiveis = listGradeGrausForCurso({ curso, nivel })
  if (grausDisponiveis.length > 1) {
    if (grauWanted && grausDisponiveis.includes(grauWanted)) {
      cursoFinal = applyGrauToCurso(curso, grauWanted)
    } else {
      const nomeBonito = applyGrauToCurso(curso, null).replace(/\b\w/g, (c) => c.toUpperCase())
      return {
        ok: false,
        code: 'GRADE_GRAU_AMBIGUOUS',
        text: `Curso ${curso} tem múltiplos graus (${grausDisponiveis.join(', ')}) — grade diferente em cada um.`,
        replyOverride:
          `O curso de *${nomeBonito}* tem duas formações: *Bacharelado* e *Licenciatura*, e a grade curricular é diferente em cada uma. ` +
          `Qual delas você quer que eu te envie?`,
      }
    }
  }

  const resolved = await resolveGradeForPdf({ curso: cursoFinal, modalidade, nivel })
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      text: resolved.error,
      replyOverride:
        'Não encontrei a grade completa desse curso aqui para gerar o PDF agora. Vou pedir para um consultor te enviar com todos os detalhes em instantes, tudo bem?',
    }
  }

  const leadId = await resolveLeadId(env, telefone, args?.id_lead ?? flowCtx.leadId)
  const nome = firstName(flowCtx.pushName || rowDb?.kommo_nome)
  const introText = buildGradePdfIntroText({
    nome,
    cursoNome: resolved.pdfInput.cursoNome,
    modalidade: resolved.pdfInput.modalidade,
    disciplinasCount: resolved.disciplinas.length,
    fileName: resolved.fileName,
  })

  const sendRes = await sendGradePdfToLead(env, {
    telefone,
    leadId,
    introText,
    pdfBuffer: resolved.buffer,
    fileName: resolved.fileName,
    caption: `Grade curricular — ${resolved.pdfInput.cursoNome} (${resolved.pdfInput.modalidade})`,
  })

  if (!sendRes.ok) {
    return {
      ok: false,
      code: 'SEND_FAILED',
      text: sendRes.error || 'Falha no envio do PDF.',
      replyOverride:
        'Tive uma instabilidade ao enviar o PDF da grade agora. Pode aguardar um instante que vou tentar de novo ou te passo para um consultor te enviar?',
    }
  }

  return {
    ok: true,
    code: 'GRADE_PDF_SENT',
    text: `PDF enviado: ${resolved.fileName} (${resolved.disciplinas.length} disciplinas).`,
    replyOverride: introText,
    ctxSnapshot: {
      gradePdf: {
        curso: resolved.pdfInput.cursoNome,
        modalidade: resolved.pdfInput.modalidade,
        nivel: resolved.row.nivel,
        fileName: resolved.fileName,
        disciplinas: resolved.disciplinas.length,
      },
    },
    steps: sendRes.steps,
  }
}

function shouldAutoSendGradePdf(leadText) {
  // Remove cláusulas que são eco do próprio agente (ex.: "...grade curricular
  // em PDF...") para não confundir a oferta passada do agente com pedido do lead.
  const clean = stripAgentEchoClauses(leadText)
  if (!clean || clean.length < 4) return false
  const asksGrade = messageAsksGradeCurricular(clean) || messageAsksGradePdf(clean)
  if (!asksGrade) return false
  if (messageAsksCampusOrPhoneContact(clean) || messageAsksLocationInfo(clean)) return false
  // O lead também perguntou preço, custo, início, etc.: deixa o LLM responder
  // tudo (ele chama enviar_grade_pdf + responde os demais pontos). O envio
  // automático pré-LLM só dispara quando o pedido é exclusivamente de grade.
  if (messageAsksOtherTopicBesidesGrade(clean)) return false
  if (messageAsksCoursePrice(clean) || messageAsksPaymentInfo(clean) || messageAsksCourseInquiry(clean)) {
    return false
  }
  return true
}

/**
 * Handler pré-LLM: lead pediu grade curricular ou PDF — envia PDF direto quando possível.
 */
export async function tryHandleGradePdfRequest(env, flowCtx) {
  const { userMessage, telefone } = flowCtx
  if (!telefone || !userMessage) return null

  const leadText = sanitizeLeadInboundMessage(extractLeadTextAfterAgentEcho(userMessage) || userMessage)
  if (!leadText) return null
  if (!shouldAutoSendGradePdf(leadText)) return null

  const result = await runEnviarGradePdf(env, { telefone: flowCtx.telefone }, { ...flowCtx, userMessage: leadText })
  if (!result.ok && (result.code === 'MISSING_CURSO' || result.code === 'GRADE_NOT_FOUND')) return null
  return {
    handled: true,
    result: {
      ok: result.ok,
      reply: result.replyOverride,
      toolCalls: [{ tool: 'enviar_grade_pdf', code: result.code }],
      orchestratorSteps: [{ type: 'grade_pdf_auto', code: result.code, ok: result.ok }],
      ctxSnapshot: result.ctxSnapshot || {},
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      durationMs: 0,
      executionId: flowCtx.executionId,
      model: flowCtx.model,
    },
  }
}
