/**
 * Versão server-side do loop do Playground: recebe a mensagem já “juntada” do
 * lead + telefone, monta o system (APAGAR.txt + override), injeta as últimas N
 * mensagens do n8n_chat_histories como turnos anteriores e roda até 5 rodadas
 * de tool_calls.
 */

import { loadPrompts, buildSystemMessage } from './promptsLoader.js'
import { classifyMessageScope } from './scopeClassifier.js'
import { getToolDefinitions } from './toolDefinitions.js'
import { buildToolExecutors } from './toolExecutorsServer.js'
import { runBuscarHistorico } from '../memoryTool.js'
import { readChatMessages } from '../historyStore.js'
import { mergeHistoriesDedupe, trimHistoryTail } from '../../libShared/historyMerge.js'
import { fetchLeadFormSnapshot } from '../inscricaoKommoFields.js'
import { generateExecutionId } from './executionTelemetry.js'
import { resolveModel } from './modelRegistry.js'
import { createExecutionContext } from './executionContext.js'
import {
  messageLooksCareerIncomeOpportunity,
  buildCommercialRedirectSearchQuery,
  isGreetingOnly,
  buildGreetingReply,
  shouldHandoffToHuman,
  detectHandoffMotivo,
  buildHumanHandoffReply,
  shouldBypassScopeBlock,
} from '../../libShared/scopeHeuristics.js'
import { buildContextualGreetingReply } from '../../libShared/conversationContextHeuristics.js'
import {
  detectCursoConfirmadoPeloLead,
  extractCursoAreaFromText,
  messageIsBareCourseSelection,
} from '../../libShared/cursoConfirmation.js'
import { setSumCursoOnLead } from '../sumareLeadFields.js'
import { tryHandleUnsupportedCourseLevelInquiry } from '../courseLevelInquiry.js'
import { runDistribuirHumano, formatDistribuirHumanoReply } from '../distribuirHumanoTool.js'
import {
  tryHandleInscricaoFormComplete,
  tryHandleInscricaoFormStart,
  tryEnsureInscricaoFormSent,
  tryHandleMatriculaAceitePagamentoFlow,
} from '../inscricaoFormFlow.js'
import { detectFormSumarRecebidoNoKommo } from '../inscricaoPostFormPipeline.js'
import { tryHandlePoloEscolhaFlow } from '../inscricaoPoloFlow.js'
import {
  messageExpressesCourseInterestOnly,
  messageLooksLikeFormSumarResponse,
  messageIsFlowResponsesReceived,
  messageLooksLikeFormFollowUp,
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  matriculaPosFormAlreadyProcessed,
  messageConfirmsProceedToInscricaoForm,
  isShortEnrollmentConfirmation,
  assistantInEnrollmentStep,
} from '../../libShared/inscricaoFormHeuristics.js'
import { fetchDadosClienteByTelefone } from '../dadosClienteStore.js'
import { DADOS_CLIENTE_INSCRICAO_SELECT } from '../dadosClienteInscricaoFields.js'
import { leadHasPostFormRegistradoNote } from '../postFormSendGuard.js'
import {
  conversationHasActiveTopic,
  extractDiscussedCourseFromHistory,
  assistantAskedEnrollmentInLastReply,
  userLikelyContinuingEnrollmentFlow,
  messageExpressesFrustrationAlreadySaid,
  lastAssistantText,
} from '../../libShared/conversationContextHeuristics.js'
import { messageIsInboundMediaPlaceholder } from '../../libShared/scopeHeuristics.js'
import {
  messageAsksCoursePrice,
  sanitizeLeadInboundMessage,
} from '../../libShared/inboundMessageSanitize.js'
import { isAtendimentoIaPaused } from '../dadosClienteStore.js'

const MAX_TOOL_ROUNDS = 5
const CHAT_URL = 'https://api.openai.com/v1/chat/completions'

function resolveHistoryLimit(env) {
  const n = Number(env.AGENT_HISTORY_CONTEXT || 8)
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : 8
}

/**
 * Carrega histórico recente da conversa.
 *
 * Tenta `n8n_chat_histories` primeiro (formato LangChain, fonte canônica).
 * Se vier vazio, faz fallback pra `chat_messages` — que é populada pelo
 * nosso webhook E pelo n8n legado, e cobre o cenário "turno anterior
 * existe mas não está em n8n_chat_histories" (n8n antigo, falha
 * silenciosa do appendChatMemory etc).
 *
 * Sem isso, a IA ficava sem contexto e alucinava cursos quando o lead
 * mandava só "Sim"/"Ok" — caso real visto em EX-260506-1702-057.
 *
 * Retorna { messages, source } pra dar visibilidade no debug.
 */
function sanitizeHistoryMessages(messages) {
  return (messages || []).filter((m) => {
    const c = String(m?.content || '').trim()
    if (!c || c.length < 2) return false
    if (m.role === 'system') return false
    if (/^\[(scheduler|system|legenda|áudio|audio|imagem|mensagem)\]/i.test(c)) return false
    if (/\[scheduler\]/i.test(c)) return false
    return true
  })
}

async function loadRecentHistoryMessages(env, telefone) {
  if (!telefone) return { messages: [], source: 'none' }
  const limit = resolveHistoryLimit(env)
  const maxTail = Math.max(limit * 2, 16)

  let n8nMsgs = []
  let chatMsgs = []
  try {
    const out = await runBuscarHistorico(env, { telefone, limit })
    if (out.ok && Array.isArray(out.mensagens) && out.mensagens.length > 0) {
      n8nMsgs = sanitizeHistoryMessages(
        out.mensagens
          .map((m) => {
            if (m.role === 'lead') return { role: 'user', content: m.content }
            if (m.role === 'assistente') return { role: 'assistant', content: m.content }
            return null
          })
          .filter(Boolean),
      )
    }
  } catch (err) {
    console.warn('[agentRunner] histórico (n8n_chat_histories) indisponível:', err.message)
  }

  try {
    chatMsgs = sanitizeHistoryMessages(await readChatMessages(env, telefone, limit))
  } catch (err) {
    console.warn('[agentRunner] histórico (chat_messages fallback) indisponível:', err.message)
  }

  const merged = trimHistoryTail(mergeHistoriesDedupe(n8nMsgs, chatMsgs), maxTail)
  if (merged.length > 0) {
    let source = 'empty'
    if (n8nMsgs.length && chatMsgs.length) source = 'merged_n8n_chat'
    else if (n8nMsgs.length) source = 'n8n_chat_histories'
    else source = 'chat_messages_fallback'
    return { messages: merged, source }
  }

  return { messages: [], source: 'empty' }
}

/** "sim" após inscrição: recupera curso do Kommo se o histórico veio incompleto. */
async function enrichHistoryForShortEnrollmentConfirm(env, leadId, userMessage, historyMessages) {
  if (!isShortEnrollmentConfirmation(userMessage)) return historyMessages
  if (assistantAskedEnrollmentInLastReply(historyMessages)) return historyMessages
  if (!leadId) return historyMessages
  try {
    const snap = await fetchLeadFormSnapshot(env, leadId)
    if (!snap.ok || !snap.snapshot) return historyMessages
    const curso = String(snap.snapshot.sum_curso || snap.snapshot.curso || '').trim()
    if (!curso) return historyMessages
    return [
      ...historyMessages,
      {
        role: 'assistant',
        content: `Quer que eu te ajude com a inscrição no curso de ${curso}?`,
      },
    ]
  } catch {
    return historyMessages
  }
}

// Confirmações curtas/ambíguas — quando o lead manda só isso e a memória
// está vazia, a IA tendia a ALUCINAR um curso (caso "Administração" da
// EX-260506-1702-057). Lista mantida estreita pra não bloquear respostas
// legítimas.
const AMBIGUOUS_SHORT_REPLIES = new Set([
  'sim', 's', 'isso', 'claro', 'ok', 'okay', 'beleza', 'pode ser',
  'tá', 'ta', 'ta bom', 'ta bem', 'tá bom', 'tá bem',
  'não', 'nao', 'n', 'não entendi', 'nao entendi',
  '?', '??', '???',
])

function isAmbiguousShortReply(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?]+$/, '')
  if (!t) return false
  if (t.length > 18) return false
  return AMBIGUOUS_SHORT_REPLIES.has(t)
}

async function callOpenAI(env, apiMessages, model, tools) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: apiMessages,
      tools,
      temperature: 0.7,
      max_tokens: 2048,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

async function executeToolCalls(executors, toolCalls, trace, ctx) {
  const results = []
  for (const tc of toolCalls) {
    const fn = tc.function
    const step = { tool: fn.name, args: {}, result: null, error: null, durationMs: 0 }
    const executor = executors[fn.name]
    if (!executor) {
      step.error = `Ferramenta "${fn.name}" não disponível`
      trace.push(step)
      results.push({ tool_call_id: tc.id, role: 'tool', content: step.error })
      continue
    }
    const t0 = Date.now()
    try {
      const args = JSON.parse(fn.arguments || '{}')
      step.args = args
      const result = await executor(args)
      step.result = result || 'Nenhum resultado encontrado na base.'
      step.durationMs = Date.now() - t0
      results.push({ tool_call_id: tc.id, role: 'tool', content: String(step.result) })
    } catch (e) {
      step.error = e.message
      step.durationMs = Date.now() - t0
      results.push({ tool_call_id: tc.id, role: 'tool', content: `Erro: ${e.message}` })
    }
    // Anexa o trace de "auditoria" do query rewrite (se for tool de
    // busca vetorial). Vem do executionContext, populado em
    // toolExecutorsServer.vectorSearch.
    if (ctx?.consumeToolTrace) {
      const qrTrace = ctx.consumeToolTrace(fn.name)
      if (qrTrace) step.queryRewrite = qrTrace
    }
    trace.push(step)
  }
  return results
}

/**
 * @param {object} env    process.env
 * @param {object} input  { telefone, userMessage, pushName, executionId?, leadId? }
 * @returns { ok, reply, toolCalls[], usage, durationMs, executionId, model, aiMeta }
 *   `aiMeta` agrega usage de sub-chamadas (query rewrite, tools com LLM
 *   próprio, embeddings) — usado pelo dashboard pra calcular custo real.
 */
export async function runAgent(env, input) {
  const t0 = Date.now()
  const telefone = input?.telefone || ''
  const rawUserMessage = (input?.userMessage || '').trim()
  const userMessage = sanitizeLeadInboundMessage(rawUserMessage)
  if (rawUserMessage && userMessage !== rawUserMessage) {
    console.log(
      `[${input?.executionId || 'agent'}] INBOUND_SANITIZE rawLen=${rawUserMessage.length} cleanLen=${userMessage.length} preview="${userMessage.slice(0, 120)}"`,
    )
  }
  const executionId = input?.executionId || generateExecutionId()
  const leadId = Number.isFinite(Number(input?.leadId)) && Number(input?.leadId) > 0 ? Number(input.leadId) : null
  const model = resolveModel(env, 'orchestrator')
  const ctx = createExecutionContext()
  if (!userMessage) return { ok: false, error: 'Mensagem vazia', executionId, model, aiMeta: ctx.toAiMeta() }

  const formFlowCtx = { telefone, userMessage, historyMessages: [], executionId, model, leadId, pushName: input?.pushName, t0 }

  if (telefone) {
    const aceiteFlow = await tryHandleMatriculaAceitePagamentoFlow(env, formFlowCtx)
    if (aceiteFlow?.handled) {
      console.log(
        `[${executionId}] MATRICULA_ACEITE_PAGAMENTO step=${aceiteFlow.result?.ctxSnapshot?.inscricaoForm ?? 'n/a'}`,
      )
      return {
        ...aceiteFlow.result,
        historyLoaded: 0,
        aiMeta: ctx.toAiMeta(),
      }
    }

    const poloFlow = await tryHandlePoloEscolhaFlow(env, formFlowCtx)
    if (poloFlow?.handled) {
      console.log(
        `[${executionId}] POLO_ESCOLHA polo=${poloFlow.result?.ctxSnapshot?.poloId ?? 'n/a'} unidade=${poloFlow.result?.ctxSnapshot?.unidade ?? 'n/a'}`,
      )
      return {
        ...poloFlow.result,
        historyLoaded: 0,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  // Gate `ia_paused` é responsabilidade do caller (webhookEvolution faz o
  // check antes do drain — ver flushSessionInner). Aqui mantemos a checagem
  // apenas como rede de segurança para callers alternativos (playground/
  // server.js POST /api/agent/run) que invocam runAgent direto. Quando o
  // caller já checou (skipPauseCheck:true), evitamos round-trip a Supabase.
  if (telefone && !input?.skipPauseCheck && (await isAtendimentoIaPaused(env, telefone))) {
    console.log(`[${executionId}] IA pausada (atendimento_ia=pause) telefone=${telefone}`)
    return {
      ok: true,
      reply: null,
      iaPaused: true,
      skipped: true,
      toolCalls: [],
      orchestratorSteps: [{ type: 'ia_paused', durationMs: Date.now() - t0 }],
      ctxSnapshot: { iaPaused: true },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      durationMs: Date.now() - t0,
      executionId,
      model,
      aiMeta: ctx.toAiMeta(),
    }
  }

  const [prompts, historyResult] = await Promise.all([
    loadPrompts(),
    loadRecentHistoryMessages(env, telefone),
  ])
  let historyMessages = historyResult.messages
  const historySource = historyResult.source

  if (telefone && leadId) {
    const enriched = await enrichHistoryForShortEnrollmentConfirm(
      env,
      leadId,
      userMessage,
      historyMessages,
    )
    if (enriched.length !== historyMessages.length) {
      console.log(
        `[${executionId}] HISTORICO_ENRIQUECIDO kommo_curso turnos=${enriched.length} (era ${historyMessages.length})`,
      )
      historyMessages = enriched
    }
  }

  // Loga o histórico carregado pra cada execução. Antes não tínhamos
  // visibilidade se a memória vinha vazia / curta — o agente parecia
  // "esquecer" de turnos anteriores e era difícil diagnosticar.
  const historyPreview = historyMessages.slice(-6).map((m) => ({
    role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : m.role,
    content: String(m.content || '').slice(0, 200),
  }))
  console.log(
    `[${executionId}] CARREGOU_HISTORICO msgs=${historyMessages.length} source=${historySource} telefone=${telefone || 'n/a'}`,
  )
  console.log(
    `[${executionId}] history loaded: ${historyMessages.length} msgs from ${historySource} (telefone=${telefone || 'n/a'})`,
  )
  if (historyMessages.length > 0) {
    for (const m of historyPreview) {
      console.log(`  [${m.role}] ${m.content.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  }
  ctx.recordHistorySnapshot?.({
    count: historyMessages.length,
    source: historySource,
    preview: historyPreview,
  })

  formFlowCtx.historyMessages = historyMessages

  // "sim" / "ok" após pergunta de inscrição → Form Sumar (antes de cair no orquestrador sem contexto).
  if (telefone && isShortEnrollmentConfirmation(userMessage)) {
    if (messageConfirmsProceedToInscricaoForm(userMessage, historyMessages)) {
      const formEarly = await tryHandleInscricaoFormStart(env, formFlowCtx)
      if (formEarly?.handled) {
        console.log(
          `[${executionId}] INSCRICAO_FORM_START early_confirm enrollment_step=${assistantInEnrollmentStep(lastAssistantText(historyMessages))}`,
        )
        return { ...formEarly.result, historyLoaded: historyMessages.length, aiMeta: ctx.toAiMeta() }
      }
    }
  }

  // ── Shortcut barato: saudação pura (com ou sem contexto). Adiantado
  // pra rodar ANTES das chamadas Kommo (sum_curso), pós-form, course
  // level e handoff — saudação não precisa de nenhuma dessas etapas e
  // economiza I/O. Histórico já está carregado então o contexto continua
  // funcionando (saudação contextual mantida).
  if (isGreetingOnly(userMessage)) {
    const hasContext =
      conversationHasActiveTopic(historyMessages) ||
      Boolean(extractDiscussedCourseFromHistory(historyMessages))
    const greetingReply = hasContext
      ? buildContextualGreetingReply({ userMessage, pushName: input?.pushName, historyMessages })
      : buildGreetingReply({ userMessage, pushName: input?.pushName })
    ctx.recordScopeClassification?.({
      blocked: false,
      source: 'heuristic',
      reason: hasContext ? 'greeting_continuacao' : 'greeting',
      classification: {
        dentro_escopo: true,
        categoria: hasContext ? 'saudacao_continuacao' : 'saudacao',
        nivel: 'indefinido',
        motivo: hasContext ? 'saudação com conversa em andamento' : 'saudação simples',
      },
    })
    console.log(`[${executionId}] GREETING handled contexto=${hasContext} (sem orquestrador)`)
    return {
      ok: true,
      reply: greetingReply,
      scopeBlocked: false,
      greetingHandled: true,
      toolCalls: [],
      orchestratorSteps: [{ type: 'greeting', durationMs: Date.now() - t0 }],
      ctxSnapshot: { greeting: true },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      durationMs: Date.now() - t0,
      historyLoaded: historyMessages.length,
      executionId,
      model,
      aiMeta: ctx.toAiMeta(),
    }
  }

  // Pré-preenchimento sum_Curso: assim que o lead confirma interesse num
  // curso (mesmo antes de pedir inscrição), gravamos no Kommo. Função
  // interna já trata dedupe (mesmo lead+curso em <6h) — log apenas.
  if (telefone) {
    try {
      const cursoConfirmado = detectCursoConfirmadoPeloLead(userMessage, historyMessages)
      if (cursoConfirmado) {
        const r = await setSumCursoOnLead(env, { leadId, telefone, cursoNome: cursoConfirmado })
        console.log(
          `[${executionId}] SUM_CURSO_UPDATE curso="${cursoConfirmado}" ok=${r.ok} skipped=${Boolean(r.skipped)} code=${r.code || 'n/a'} previous="${r.previous || ''}"`,
        )
      }
    } catch (err) {
      console.warn(`[${executionId}] SUM_CURSO_UPDATE erro: ${err.message}`)
    }
  }

  if (telefone) {
    // Pós-form só quando a mensagem indica formulário respondido — evita pular
    // direto para "cadastro validado" em "sim"/"oi" com notas antigas no Kommo.
    let matriculaJaProcessada = false
    let inscRow = null
    try {
      if (leadId != null && (await leadHasPostFormRegistradoNote(env, leadId))) {
        matriculaJaProcessada = true
      }
      if (!matriculaJaProcessada) {
        inscRow = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_INSCRICAO_SELECT)
        matriculaJaProcessada = matriculaPosFormAlreadyProcessed(inscRow)
      }
    } catch {
      /* segue sem bloquear */
    }

    const formStatus = inscRow?.inscricao_form_status ?? null
    const waitingForForm = [
      INSCRICAO_FORM_STATUS_AGUARDANDO,
      INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
    ].includes(formStatus)
    const flowTextInbound =
      messageLooksLikeFormSumarResponse(userMessage) || messageIsFlowResponsesReceived(userMessage)

    let kommoFlowDetected = false
    if (!matriculaJaProcessada && leadId && (waitingForForm || flowTextInbound)) {
      try {
        const det = await detectFormSumarRecebidoNoKommo(env, leadId)
        kommoFlowDetected = Boolean(det.detected)
        if (kommoFlowDetected) {
          console.log(
            `[${executionId}] FLOW_FORM_KOMMO lead=${leadId} source=${det.source || 'n/a'} sample="${String(det.sample || '').slice(0, 80)}"`,
          )
        }
      } catch (detErr) {
        console.warn(`[${executionId}] FLOW_FORM_KOMMO erro: ${detErr.message}`)
      }
    }

    const looksPostFormInbound =
      !matriculaJaProcessada &&
      (flowTextInbound ||
        kommoFlowDetected ||
        (waitingForForm && messageLooksLikeFormFollowUp(userMessage, { strictAwaitingForm: true })))

    if (flowTextInbound) {
      console.log(
        `[${executionId}] FLOW_FORM_INBOUND flow_received=${messageIsFlowResponsesReceived(userMessage)} status=${formStatus || 'n/a'}`,
      )
    }

    const formDone = looksPostFormInbound
      ? await tryHandleInscricaoFormComplete(env, formFlowCtx)
      : null
    if (formDone?.handled) {
      const step = formDone.result?.ctxSnapshot?.inscricaoForm ?? 'post_form'
      console.log(
        `[${executionId}] INSCRICAO_POST_FORM step=${step} captacao=${formDone.result?.ctxSnapshot?.sumareCaptacao ?? 'n/a'} salesbot=${formDone.result?.ctxSnapshot?.salesbotId ?? formDone.result?.ctxSnapshot?.distribSalesbotId ?? 'n/a'}`,
      )
      return { ...formDone.result, historyLoaded: historyMessages.length, aiMeta: ctx.toAiMeta() }
    }
    const formStart = await tryHandleInscricaoFormStart(env, formFlowCtx)
    if (formStart?.handled) {
      console.log(
        `[${executionId}] INSCRICAO_FORM_START salesbot=${formStart.result?.ctxSnapshot?.salesbotId ?? formStart.result?.toolCalls?.[0]?.ok ?? 'n/a'}`,
      )
      return { ...formStart.result, historyLoaded: historyMessages.length, aiMeta: ctx.toAiMeta() }
    }

    const courseLevel = await tryHandleUnsupportedCourseLevelInquiry(env, {
      ...formFlowCtx,
      historyMessages,
    })
    if (courseLevel?.handled) {
      console.log(`[${executionId}] CURSO_TECNICO_ALTERNATIVA (graduação sugerida)`)
      return { ...courseLevel.result, historyLoaded: historyMessages.length, aiMeta: ctx.toAiMeta() }
    }
  }

  if (telefone && shouldHandoffToHuman(userMessage, historyMessages)) {
    const handoffMotivo = detectHandoffMotivo()
    const dist = await runDistribuirHumano(env, {
      telefone,
      id_lead: leadId,
      motivo: handoffMotivo,
    })
    if (dist._meta?.toolUsage) {
      for (const u of dist._meta.toolUsage) ctx.recordToolUsage(u)
    }
    const salesbotStep = dist.steps?.find((s) => s.step === 'kommo_salesbot')
    const pauseStep = dist.steps?.find((s) => s.step === 'supabase_dados_cliente_pause')
    const handoffOk = Boolean(dist.ok && pauseStep?.ok)
    console.log(
      `[${executionId}] AUTO_DISTRIBUIR_HUMANO motivo=${handoffMotivo} ok=${dist.ok} salesbot_ok=${salesbotStep?.ok} bot_id=${salesbotStep?.bot_id ?? 'n/a'} mode=${dist.handoff_mode ?? 'n/a'}`,
    )
    return {
      ok: true,
      reply: buildHumanHandoffReply({ ok: handoffOk, pushName: input?.pushName, motivo: handoffMotivo }),
      distribuirHumanoHandled: true,
      toolCalls: [
        {
          tool: 'distribuir_humano',
          args: { telefone, id_lead: leadId, motivo: handoffMotivo },
          result: formatDistribuirHumanoReply(dist),
          ok: handoffOk,
          steps: dist.steps,
        },
      ],
      orchestratorSteps: [{ type: 'auto_distribuir_humano', ok: dist.ok, durationMs: Date.now() - t0 }],
      ctxSnapshot: { autoDistribuirHumano: true, distribuirOk: dist.ok },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      durationMs: Date.now() - t0,
      historyLoaded: historyMessages.length,
      executionId,
      model,
      aiMeta: ctx.toAiMeta(),
    }
  }

  let skipScopeCheck =
    (historyMessages.length === 0 && isAmbiguousShortReply(userMessage)) ||
    Boolean(extractCursoAreaFromText(userMessage)) ||
    messageIsBareCourseSelection(userMessage, historyMessages)
  let scopeClassification = null
  if (!skipScopeCheck) {
    const scope = await classifyMessageScope(env, { userMessage, historyMessages })
    scopeClassification = scope.classification
    ctx.recordScopeClassification?.({
      blocked: scope.blocked,
      source: scope.source,
      reason: scope.reason,
      classification: scope.classification,
      model: scope.model,
      usage: scope.usage,
    })
    console.log(
      `[${executionId}] SCOPE_CLASSIFIER blocked=${scope.blocked} source=${scope.source} reason=${scope.reason}` +
        (scope.classification?.categoria ? ` categoria=${scope.classification.categoria}` : ''),
    )
    if (
      scope.blocked &&
      scope.reply &&
      shouldBypassScopeBlock(userMessage, historyMessages)
    ) {
      console.log(
        `[${executionId}] SCOPE_CLASSIFIER override — continuacao de atendimento (nao bloquear)`,
      )
      scope.blocked = false
      scope.reply = null
    }

    // Reforço opcional (PR 2.3): SCOPE_BLOCK_REQUIRE_NO_CONTEXT=true exige
    // ausência total de contexto ativo (curso em discussão recente) pra
    // efetivar o bloqueio. Em produção começamos com o flag desligado e
    // monitoramos via log; se houver falso-bloqueios escapando do bypass
    // acima, ligamos o flag pra suprimir o envio da recusa sem perder a
    // mensagem (que já não vai virar resposta — só log).
    const requireNoContextForBlock =
      String(env.SCOPE_BLOCK_REQUIRE_NO_CONTEXT || 'false').toLowerCase() === 'true'
    if (
      scope.blocked &&
      scope.reply &&
      requireNoContextForBlock &&
      (conversationHasActiveTopic(historyMessages) ||
        Boolean(extractDiscussedCourseFromHistory(historyMessages)))
    ) {
      console.log(
        `[${executionId}] SCOPE_CLASSIFIER bloqueio suprimido — SCOPE_BLOCK_REQUIRE_NO_CONTEXT=true e contexto ativo na conversa (reply NÃO será enviado)`,
      )
      scope.blocked = false
      scope.reply = null
    }

    if (scope.blocked && scope.reply) {
      const scopeUsage = scope.usage
        ? {
            prompt_tokens: scope.usage.prompt_tokens || 0,
            completion_tokens: scope.usage.completion_tokens || 0,
            total_tokens: scope.usage.total_tokens || 0,
          }
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      return {
        ok: true,
        reply: scope.reply,
        scopeBlocked: true,
        toolCalls: [],
        orchestratorSteps: [
          {
            type: 'scope_classifier',
            blocked: true,
            source: scope.source,
            reason: scope.reason,
            classification: scope.classification,
            model: scope.model,
            durationMs: scope.elapsedMs,
            usage: scope.usage,
          },
        ],
        ctxSnapshot: {
          scopeClassifier: true,
          classification: scope.classification,
        },
        usage: scopeUsage,
        durationMs: Date.now() - t0,
        historyLoaded: historyMessages.length,
        executionId,
        model,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  const toolDefinitions = getToolDefinitions(env)
  const systemMessage = buildSystemMessage(prompts, env)
  // Contexto do atendimento — telefone + id_lead vão p/ o LLM sempre
  // que disponíveis. Sem id_lead aqui, o LLM tendia a chamar tools
  // (inscricao / distribuir_humano) com `id_lead: 0` (default da
  // OpenAI), causando MISSING_CRM_FIELDS e o fluxo nunca completava.
  const contextLines = []
  if (telefone) contextLines.push(`- Telefone do lead: ${telefone}`)
  if (leadId) contextLines.push(`- id_lead (Kommo): ${leadId}`)
  if (input?.pushName) contextLines.push(`- Nome (pushName): ${input.pushName}`)
  const contextPreamble = contextLines.length > 0 ? `Contexto do atendimento:\n${contextLines.join('\n')}` : ''

  // BACKSTOP CRÍTICO — sem histórico + msg ambígua ("Sim", "Ok", "?")
  // a IA tende a alucinar curso (caso "Administração" do EX-260506-1702-057).
  // Injetamos system extra deixando MUITO claro que o LLM não pode inventar
  // nem mencionar nomes de cursos que o lead não falou.
  const commercialOpportunity =
    messageLooksCareerIncomeOpportunity(userMessage) ||
    scopeClassification?.categoria === 'oportunidade_comercial'
  const commercialHint = commercialOpportunity
    ? {
        role: 'system',
        content:
          'OPORTUNIDADE COMERCIAL: o lead falou de carreira, renda ou mundo digital. ' +
          `Chame buscar_conhecimento neste turno (query sugerida: "${buildCommercialRedirectSearchQuery(userMessage)}"). ` +
          'Acolha o objetivo, mencione com naturalidade que diploma/formação superior abre portas no médio prazo, cite 1–3 cursos só do CONTEXT e convide a saber valores ou matrícula. Não recuse como fora do escopo.',
      }
    : null

  const courseFromMsg = extractDiscussedCourseFromHistory([
    ...historyMessages,
    { role: 'user', content: userMessage },
  ])
  const courseInterestHint = messageExpressesCourseInterestOnly(userMessage, historyMessages)
    ? {
        role: 'system',
        content:
          'INTERESSE EM CURSO (ainda sem confirmação de matrícula): o lead citou um curso ou pediu para fazer um curso. ' +
          `OBRIGATÓRIO neste turno: chame buscar_conhecimento (query com o curso, ex.: "${courseFromMsg || 'nome do curso mencionado'}") ` +
          'e/ou buscar_precos conforme o nível. Apresente informações objetivas do CONTEXT (modalidade, duração, investimento quando existir). ' +
          'Depois pergunte explicitamente se deseja seguir com a matrícula/inscrição. ' +
          'PROIBIDO neste turno: distribuir_humano, dizer que já enviou o formulário — o sistema só dispara o Formulario_Sum após confirmação explícita.',
      }
    : null

  const activeCourse = extractDiscussedCourseFromHistory(historyMessages)
  const activeFlowHint =
    conversationHasActiveTopic(historyMessages) || messageIsInboundMediaPlaceholder(userMessage)
      ? {
          role: 'system',
          content:
            'ATENDIMENTO COMERCIAL EM ANDAMENTO' +
            (activeCourse ? ` (curso: ${activeCourse})` : '') +
            '. O lead NÃO pediu consultor humano de forma explícita. ' +
            'OBRIGATÓRIO: buscar_conhecimento e/ou buscar_precos sobre o curso em pauta antes de qualquer encaminhamento. ' +
            'PROIBIDO chamar distribuir_humano neste turno, exceto se o lead escrever claramente que quer falar com humano/atendente/consultor. ' +
            (messageIsInboundMediaPlaceholder(userMessage)
              ? 'Se veio áudio: interprete a transcrição no contexto da conversa; se não entendeu, peça para digitar — não encaminhe para consultor.'
              : ''),
        }
      : null

  const enrollmentContinuation =
    userLikelyContinuingEnrollmentFlow(userMessage, historyMessages) ||
    (isShortEnrollmentConfirmation(userMessage) &&
      messageConfirmsProceedToInscricaoForm(userMessage, historyMessages))

  const ambiguousNoContext =
    historyMessages.length === 0 &&
    isAmbiguousShortReply(userMessage) &&
    !enrollmentContinuation

  const frustrationAlreadySaid =
    messageExpressesFrustrationAlreadySaid(userMessage) &&
    (conversationHasActiveTopic(historyMessages) ||
      Boolean(extractDiscussedCourseFromHistory(historyMessages)))

  const enrollmentConfirmHint =
    enrollmentContinuation && !messageAsksCoursePrice(userMessage)
      ? {
          role: 'system',
          content:
            'CONFIRMAÇÃO DE MATRÍCULA: o lead respondeu de forma afirmativa após você perguntar sobre inscrição/matrícula no curso em pauta. ' +
            `Curso em discussão: ${extractDiscussedCourseFromHistory(historyMessages) || 'ver sum_Curso/histórico'}. ` +
            'OBRIGATÓRIO neste turno: acionar a tool inscricao (Formulário Sumar) — não pergunte de novo "qual curso". ' +
            'PROIBIDO resetar o atendimento ou pedir que o lead repita o nome do curso.',
        }
      : null

  const priceQueryHint = messageAsksCoursePrice(userMessage)
    ? {
        role: 'system',
        content:
          'PERGUNTA SOBRE VALORES/PREÇO: o lead quer saber quanto custa o curso em pauta. ' +
          `OBRIGATÓRIO neste turno: chame buscar_precos (e buscar_conhecimento se precisar de contexto) para o curso "${extractDiscussedCourseFromHistory(historyMessages) || extractCursoAreaFromText(userMessage) || 'mencionado no histórico'}". ` +
          'Responda com mensalidade promocional e preço cheio SOMENTE com dados do CONTEXT. ' +
          'PROIBIDO neste turno: tool inscricao, enviar formulário, perguntar só "quer inscrição?" sem informar valores.',
      }
    : null

  const frustrationHint =
    frustrationAlreadySaid && !messageAsksCoursePrice(userMessage)
      ? {
          role: 'system',
          content:
            'O lead indicou que JÁ informou o curso/interesse. Peça desculpas breves, cite o curso que consta no histórico ' +
            `(${extractDiscussedCourseFromHistory(historyMessages) || 'Gestão Financeira ou o último curso citado'}) ` +
            'e ofereça seguir com inscrição (tool inscricao) ou tirar dúvida sobre ESSE curso — nunca pergunte "qual curso" de novo.',
        }
      : null

  const noContextWarning = ambiguousNoContext
    ? {
        role: 'system',
        content:
          '⚠️ AVISO CRÍTICO — VOCÊ NÃO TEM HISTÓRICO DESTA CONVERSA E O LEAD ENVIOU APENAS UMA CONFIRMAÇÃO CURTA OU AMBÍGUA. ' +
          'Você NÃO sabe sobre o que ele está confirmando. ' +
          'É TERMINANTEMENTE PROIBIDO: (a) mencionar qualquer nome de curso (Administração, Direito, Pedagogia, RH, etc.) que o lead não escreveu nesta mensagem; ' +
          '(b) propor inscrição em qualquer curso específico; (c) dar continuidade a um suposto fluxo anterior. ' +
          'AÇÃO OBRIGATÓRIA: pergunte gentilmente em qual curso ou assunto ele tem interesse, ou peça pra ele reformular a mensagem. ' +
          'Exemplo de resposta correta: "Oi! Para te ajudar melhor, em qual curso você tem interesse?"',
      }
    : null

  const apiMessages = [
    { role: 'system', content: systemMessage },
    ...(contextPreamble ? [{ role: 'system', content: contextPreamble }] : []),
    ...(commercialHint ? [commercialHint] : []),
    ...(courseInterestHint ? [courseInterestHint] : []),
    ...(activeFlowHint ? [activeFlowHint] : []),
    ...(priceQueryHint ? [priceQueryHint] : []),
    ...(enrollmentConfirmHint ? [enrollmentConfirmHint] : []),
    ...(frustrationHint ? [frustrationHint] : []),
    ...(noContextWarning ? [noContextWarning] : []),
    ...historyMessages,
    { role: 'user', content: userMessage },
  ]
  console.log(
    `[${executionId}] MONTOU_PROMPT promptsLoaded=${prompts.length} systemChars=${systemMessage.length} historyMsgs=${historyMessages.length} ambiguousNoContext=${ambiguousNoContext} enrollmentContinuation=${enrollmentContinuation} model=${model}`,
  )

  const executors = buildToolExecutors(env, ctx)
  const toolTrace = []
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

  // Snapshot inicial do "contexto" enviado pro LLM no round 1. Útil
  // pra debug — sem isso era cego se o prompt mudou ou se o Contexto
  // (telefone/leadId) estava chegando.
  const ctxSnapshot = {
    systemPromptChars: systemMessage.length,
    contextPreamble: contextPreamble || null,
    historyCount: historyMessages.length,
    historySource,
    noContextWarning: ambiguousNoContext,
    toolsAvailable: toolDefinitions.map((t) => t.function?.name).filter(Boolean),
    userMessage,
  }

  // Steps granulares por round do orquestrador — espelha o que o
  // SalesbotExecutions já mostra.  Cada round vira um step com:
  //   - decisão do LLM (respondeu vs chamou tools)
  //   - tokens consumidos
  //   - mensagens enviadas (resumido pra não estourar o JSONB)
  //   - resposta crua do LLM (content + tool_calls + finish_reason)
  const orchestratorSteps = []

  function summarizeMessage(m) {
    if (!m || typeof m !== 'object') return null
    const out = { role: m.role }
    if (typeof m.content === 'string') {
      out.content = m.content.length > 400 ? `${m.content.slice(0, 400)}…` : m.content
    } else if (m.content == null) {
      out.content = null
    } else {
      out.content = '[non-string]'
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      }))
    }
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id
    if (m.name) out.name = m.name
    return out
  }

  try {
    let round = 0
    while (round < MAX_TOOL_ROUNDS) {
      const roundT0 = Date.now()
      const data = await callOpenAI(env, apiMessages, model, toolDefinitions)
      const roundDurationMs = Date.now() - roundT0
      const choice = data.choices?.[0]
      const msg = choice?.message
      if (!msg) throw new Error('Sem resposta da API')

      const roundUsage = data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens || 0,
            completion_tokens: data.usage.completion_tokens || 0,
            total_tokens: data.usage.total_tokens || 0,
          }
        : null
      if (roundUsage) {
        usage.prompt_tokens += roundUsage.prompt_tokens
        usage.completion_tokens += roundUsage.completion_tokens
        usage.total_tokens += roundUsage.total_tokens
      }

      const wantsTools = choice.finish_reason === 'tool_calls' || (msg.tool_calls && msg.tool_calls.length > 0)
      // Cada round salva: o que o LLM "viu" + o que decidiu fazer.
      // messagesSent fica resumido (primeiras 3 e últimas 6) pra não
      // explodir o JSONB no Supabase em conversas longas.
      const sent = apiMessages.map(summarizeMessage)
      const messagesSent = sent.length > 9
        ? [...sent.slice(0, 3), { role: 'system', content: `[…cortadas ${sent.length - 9} mensagens do meio…]` }, ...sent.slice(-6)]
        : sent
      orchestratorSteps.push({
        type: 'llm_call',
        round: round + 1,
        model,
        durationMs: roundDurationMs,
        usage: roundUsage,
        decision: wantsTools ? 'tool_calls' : 'reply',
        finishReason: choice.finish_reason || null,
        messagesSentCount: apiMessages.length,
        messagesSent,
        llmResponse: summarizeMessage(msg),
      })

      if (wantsTools) {
        apiMessages.push(msg)
        const toolResults = await executeToolCalls(executors, msg.tool_calls, toolTrace, ctx)
        apiMessages.push(...toolResults)
        round++
        continue
      }

      const reply = msg.content || 'Sem resposta.'
      const formAfter = await tryEnsureInscricaoFormSent(env, {
        ...formFlowCtx,
        llmReply: reply,
      })
      if (formAfter?.handled) {
        console.log(
          `[${executionId}] INSCRICAO_FORM_AFTER_LLM template_ok=${formAfter.result?.toolCalls?.[0]?.ok ?? false}`,
        )
        return {
          ...formAfter.result,
          toolCalls: [...(formAfter.result.toolCalls || []), ...toolTrace],
          orchestratorSteps,
          historyLoaded: historyMessages.length,
          aiMeta: ctx.toAiMeta(),
        }
      }
      return {
        ok: true,
        reply,
        toolCalls: toolTrace,
        orchestratorSteps,
        ctxSnapshot,
        usage,
        durationMs: Date.now() - t0,
        historyLoaded: historyMessages.length,
        executionId,
        model,
        aiMeta: ctx.toAiMeta(),
      }
    }
    return {
      ok: false,
      error: 'Limite de rodadas de tools atingido.',
      toolCalls: toolTrace,
      orchestratorSteps,
      ctxSnapshot,
      usage,
      durationMs: Date.now() - t0,
      executionId,
      model,
      aiMeta: ctx.toAiMeta(),
    }
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      toolCalls: toolTrace,
      orchestratorSteps,
      ctxSnapshot,
      usage,
      durationMs: Date.now() - t0,
      executionId,
      model,
      aiMeta: ctx.toAiMeta(),
    }
  }
}
