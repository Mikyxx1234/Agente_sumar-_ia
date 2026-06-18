/**
 * Tool de ação: enviar grade curricular em PDF via WhatsApp.
 */
import { fetchDadosClienteByTelefone, getLeadIdByTelefone } from './dadosClienteStore.js'
import { findLeadByPhone, listLeadNotes } from './kommoClient.js'
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
  detectNivel,
  isNivelCorrectionMessage,
  nivelConflictsWithCursoName,
} from '../libShared/gradeNivelHeuristics.js'
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

export { detectNivel } from '../libShared/gradeNivelHeuristics.js'

function gradePdfAutoEnabled(env) {
  const v = String(env?.GRADE_PDF_AUTO_ENABLED ?? 'true').trim().toLowerCase()
  return v !== 'false' && v !== '0' && v !== 'off'
}

function resolveDedupeSec(env) {
  const n = Number(env?.OUTBOUND_DEDUPE_SEC ?? env?.WHATSAPP_OUTBOUND_DEDUPE_SEC)
  return Number.isFinite(n) && n > 0 ? n : 6 * 3600
}

async function shouldSkipDuplicateGradePdf(env, leadId, fileName) {
  if (!leadId || !fileName) return { skip: false }
  const notesRes = await listLeadNotes(env, leadId, { limit: 25 })
  if (!notesRes.ok) return { skip: false }
  const cutoff = Date.now() - resolveDedupeSec(env) * 1000
  const needle = String(fileName).toLowerCase()
  for (const n of notesRes.notes || []) {
    const text = String(n?.params?.text || n?.params?.message || '').toLowerCase()
    if (!text.includes(needle) && !text.includes('pdf grade curricular')) continue
    if (!text.includes(needle)) continue
    const at = Number(n?.created_at) * 1000
    if (Number.isFinite(at) && at >= cutoff) {
      return { skip: true, reason: 'grade_pdf_recent', at }
    }
  }
  return { skip: false }
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

function applyGrauToCurso(curso, grau) {
  const base = String(curso || '')
    .replace(/\b(bacharelado|bacharel\w*|licenciatura|licenciat\w*|tecn[oó]log\w*)\b/gi, '')
    .replace(/\s*-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return grau ? `${base} ${grau}` : base
}

function resolveNivelForGrade({ args, flowCtx, curso, rowDb }) {
  if (args?.nivel === 'grad' || args?.nivel === 'pos') return args.nivel
  return detectNivel({
    curso,
    userMessage: flowCtx.userMessage,
    kommoCurso: rowDb?.kommo_curso,
  })
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

  const leadText = sanitizeLeadInboundMessage(
    extractLeadTextAfterAgentEcho(flowCtx.userMessage) || flowCtx.userMessage || '',
  )
  const asksPriceOnly =
    leadText &&
    messageAsksCoursePrice(leadText) &&
    !messageAsksGradeCurricular(leadText) &&
    !messageAsksGradePdf(leadText)
  if (asksPriceOnly) {
    return {
      ok: false,
      code: 'GRADE_BLOCKED_PRICE_QUESTION',
      text: 'Lead perguntou preço/valor — use buscar_precos neste turno.',
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
  const nivel = resolveNivelForGrade({ args, flowCtx, curso, rowDb })

  const cursoArgName = String(args?.curso || '').trim()
  if (nivelConflictsWithCursoName(cursoArgName || curso, nivel)) {
    return {
      ok: false,
      code: 'GRADE_NIVEL_CONFLICT',
      text: 'Curso citado conflita com nível detectado.',
      replyOverride:
        'Só para confirmar: você quer a grade de *graduação* ou de *pós-graduação/MBA*? Assim envio o PDF certo.',
    }
  }

  if (isNivelCorrectionMessage(leadText) && !nivel) {
    return {
      ok: false,
      code: 'GRADE_NIVEL_AMBIGUOUS',
      text: 'Correção de nível sem grad/pós resolvido.',
      replyOverride:
        'Entendi! Confirma por favor: a grade que você precisa é de *graduação* (tecnólogo/bacharel/licenciatura) ou *pós-graduação*?',
    }
  }

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
  const pdfDup = await shouldSkipDuplicateGradePdf(env, leadId, resolved.fileName)
  if (pdfDup.skip) {
    console.log(
      `[gradePdf] dedupe skip lead=${leadId} file=${resolved.fileName} reason=${pdfDup.reason}`,
    )
    return {
      ok: true,
      code: 'GRADE_PDF_DEDUPED',
      text: `PDF ${resolved.fileName} já enviado recentemente.`,
      replyOverride:
        `Já te enviei a grade *${resolved.pdfInput.cursoNome}* (${resolved.pdfInput.modalidade}) há pouco. ` +
        'Quer que eu reenvie o PDF ou prefere tirar outra dúvida sobre o curso?',
      ctxSnapshot: {
        gradePdf: { deduped: true, fileName: resolved.fileName },
      },
    }
  }

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
  const clean = stripAgentEchoClauses(leadText)
  if (!clean || clean.length < 4) return false
  const asksGrade = messageAsksGradeCurricular(clean) || messageAsksGradePdf(clean)
  if (!asksGrade) return false
  if (messageAsksCampusOrPhoneContact(clean) || messageAsksLocationInfo(clean)) return false
  if (messageAsksOtherTopicBesidesGrade(clean)) return false
  if (messageAsksCoursePrice(clean) || messageAsksPaymentInfo(clean) || messageAsksCourseInquiry(clean)) {
    return false
  }
  if (isNivelCorrectionMessage(clean)) return false
  return true
}

async function canAutoSendGradePdf(env, flowCtx, leadText) {
  if (!gradePdfAutoEnabled(env)) return { ok: false, reason: 'auto_disabled' }
  if (!shouldAutoSendGradePdf(leadText)) return { ok: false, reason: 'heuristic' }

  const rowDb = flowCtx.telefone
    ? await fetchDadosClienteByTelefone(env, flowCtx.telefone, 'kommo_curso,kommo_modalidade').catch(() => null)
    : null

  const curso = resolveCursoFromContext({
    cursoArg: null,
    userMessage: leadText,
    historyMessages: flowCtx.historyMessages,
    kommoCurso: rowDb?.kommo_curso,
  })
  if (!curso) return { ok: false, reason: 'missing_curso' }

  const nivel = detectNivel({
    curso,
    userMessage: leadText,
    kommoCurso: rowDb?.kommo_curso,
  })
  if (!nivel) return { ok: false, reason: 'ambiguous_nivel' }

  return { ok: true, curso, nivel }
}

/**
 * Handler pré-LLM: lead pediu grade curricular ou PDF — envia PDF direto quando possível.
 */
export async function tryHandleGradePdfRequest(env, flowCtx) {
  const { userMessage, telefone } = flowCtx
  if (!telefone || !userMessage) return null

  const leadText = sanitizeLeadInboundMessage(extractLeadTextAfterAgentEcho(userMessage) || userMessage)
  if (!leadText) return null

  const gate = await canAutoSendGradePdf(env, flowCtx, leadText)
  if (!gate.ok) return null

  const result = await runEnviarGradePdf(env, { telefone: flowCtx.telefone }, { ...flowCtx, userMessage: leadText })
  if (
    !result.ok &&
    (result.code === 'MISSING_CURSO' ||
      result.code === 'GRADE_NOT_FOUND' ||
      result.code === 'GRADE_NIVEL_AMBIGUOUS' ||
      result.code === 'GRADE_NIVEL_CONFLICT')
  ) {
    return null
  }
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
