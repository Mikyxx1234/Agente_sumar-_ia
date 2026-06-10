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
} from '../libShared/gradeCurricularPdfService.js'
import {
  messageAsksGradePdf,
  messageAsksGradeCurricular,
  messageAsksCoursePrice,
  messageAsksPaymentInfo,
  messageAsksCourseInquiry,
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

  const resolved = await resolveGradeForPdf({ curso, modalidade, nivel })
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
  const asksGrade = messageAsksGradeCurricular(leadText) || messageAsksGradePdf(leadText)
  if (!asksGrade) return false
  if (messageAsksCampusOrPhoneContact(leadText) || messageAsksLocationInfo(leadText)) return false
  if (messageAsksGradePdf(leadText)) return true
  return (
    messageAsksGradeCurricular(leadText) &&
    !messageAsksCoursePrice(leadText) &&
    !messageAsksPaymentInfo(leadText) &&
    !messageAsksCourseInquiry(leadText)
  )
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
