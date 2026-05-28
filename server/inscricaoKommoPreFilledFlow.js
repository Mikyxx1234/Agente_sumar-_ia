/**
 * Plano_Inscricao_CardKommo — fluxo "express" usando dados pré-preenchidos
 * no card Sumaré Comercial. Roda ANTES do `tryHandlePoloPreFormFlow` no
 * agentRunner. Política aprovada:
 *
 *   - `ux_confirma = express`           → pula confirmação genérica de dados.
 *   - `ux_inscrito = criar_novo`        → não impede nova inscrição se card
 *                                         já estiver "Inscrito".
 *   - `polo = confirma_polo`            → pergunta ao lead se mantém o
 *                                         `sum_Polo` do card (estado
 *                                         `aguardando_confirm_polo_kommo`).
 *   - `campos_extras = sim_obrigatorios`→ exige nome+cpf+email+curso+polo+
 *                                         data_nasc+modalidade. Se faltar
 *                                         qualquer um, devolve null para o
 *                                         fluxo Form Sumar tradicional seguir.
 *
 * Estados de saída:
 *   1) `null`                     → não é o caso (fluxo segue normal)
 *   2) handled (pergunta polo)    → status = aguardando_confirm_polo_kommo
 *   3) handled (executa express)  → status = aguardando_aceite_contrato
 *                                   ou distribuir_consultor em falha API
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  messageConfirmsProceedToInscricaoForm,
  messageAsksForFormResend,
  isShortEnrollmentConfirmation,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  matchPoloFromUserMessage,
  resolvePoloUnidadeCode,
  resolvePoloFromKommoSnapshot,
  messageMentionsUnlistedPoloLocation,
  buildPoloOutroLocalidadeReply,
  buildPoloEscolhaPreFormMessage,
} from '../libShared/sumarePoloCatalog.js'
import { filterHistoryMessagesForAgent } from '../libShared/historySanitize.js'
import { normalizeMessageForScope } from '../libShared/scopeHeuristics.js'
import {
  ensureDadosClienteRow,
  updateDadosCliente,
  getLeadIdByTelefone,
  fetchDadosClienteByTelefone,
} from './dadosClienteStore.js'
import {
  DADOS_CLIENTE_KOMMO_MIRROR_SELECT,
} from './dadosClienteInscricaoFields.js'
import {
  mirrorKommoCardToDadosCliente,
  evaluateKommoExpressReadiness,
} from './kommoCardMirror.js'
import { executeCaptacaoAfterFormResolved } from './inscricaoPostFormPipeline.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

function isFeatureEnabled(env = process.env) {
  const raw = String(env?.INSCRICAO_KOMMO_CARD_EXPRESS_ENABLED ?? 'true')
    .trim()
    .toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes'
}

function buildAgentReturn({ executionId, model, t0, reply, steps, toolCalls, ctxSnapshot, ok = true }) {
  return {
    ok,
    reply,
    toolCalls: toolCalls || [],
    orchestratorSteps: steps || [],
    ctxSnapshot: ctxSnapshot || {},
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    durationMs: Date.now() - t0,
    executionId,
    model,
    inscricaoFormHandled: true,
  }
}

async function resolveLeadId(env, telefone, leadIdHint) {
  if (Number.isFinite(leadIdHint) && leadIdHint > 0) return leadIdHint
  const fromDb = await getLeadIdByTelefone(env, telefone)
  if (fromDb != null) return Number(fromDb) || fromDb
  return null
}

/**
 * Detecta resposta afirmativa curta ("sim", "isso", "manter", "ok", "tá")
 * APÓS o agente ter perguntado se mantém o polo do card. Não usa a função
 * `isShortEnrollmentConfirmation` direto porque ela tem regex próprio para
 * confirmação de inscrição — aqui aceitamos termos extras como "manter".
 */
export function leadConfirmsKeepPolo(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim().replace(/[.!?]+$/, '')
  if (!t || t.length > 32) return false
  if (
    /^\s*(sim|s|isso|claro|manter|mant[eé]m|ok|okay|pode|beleza|t[aá]|isso\s+mesmo|esse\s+mesmo|pode\s+ser)\s*$/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/** "não", "não quero", "outro polo", "trocar". */
export function leadDeclinesKeepPolo(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim()
  if (!t) return false
  if (/^\s*(n[aã]o|nao|n)\s*[.!?]*\s*$/i.test(t)) return true
  if (/\b(n[aã]o|nao)\b[\s\S]{0,25}\b(quero|prefiro|gostei|esse|esse polo|polo)\b/i.test(t)) return true
  if (/\b(trocar|mudar|outro|outra)\b[\s\S]{0,20}\bpolo\b/i.test(t)) return true
  return false
}

function buildConfirmaPoloKommoReply(poloNome, opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Perfeito${nameBit}! Vi aqui no seu cadastro que o polo escolhido é *${poloNome}*. ` +
    `Confirma que quer manter *${poloNome}* como polo da sua inscrição? ` +
    `Responda *sim* para seguir ou me diga o nome de outro polo (São Miguel, Barra Funda, Tatuapé, Santana ou Pinheiros).`
  )
}

function buildExpressAckSemLinkReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Perfeito${nameBit}! Já estou processando sua inscrição na Faculdade Sumaré ` +
    `com base nos dados do seu cadastro. Em instantes envio aqui o link para ` +
    `você aceitar o contrato.`
  )
}

function buildDistribuirConsultorReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const curso = opts.cursoNome ? ` para *${opts.cursoNome}*` : ''
  return (
    `Obrigado${nameBit}! Recebi seu pedido de matrícula${curso}, mas neste momento ` +
    `não consigo concluir automaticamente — um consultor da Faculdade Sumaré vai ` +
    `entrar em contato em instantes para finalizar com você.`
  )
}

async function setStatus(env, telefone, status, leadIdHint) {
  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadIdHint,
    fields: { [FORM_STATUS_FIELD]: status },
  }).catch(() => {})
  return updateDadosCliente(env, {
    telefone,
    fields: { [FORM_STATUS_FIELD]: status },
  }).catch(() => null)
}

/**
 * @param {Record<string,string>} env
 * @param {{
 *   telefone: string,
 *   userMessage: string,
 *   executionId?: string,
 *   model?: string,
 *   leadId?: number|string,
 *   pushName?: string,
 *   t0?: number,
 *   historyMessages?: Array,
 * }} input
 * @returns {Promise<null | { handled: true, result: object }>}
 */
export async function tryHandleInscricaoFromKommoCard(env, input) {
  if (!isFeatureEnabled(env)) return null

  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName } = input
  const t0 = input.t0 || Date.now()
  if (!telefone || !String(userMessage || '').trim()) return null

  const historyMessages = filterHistoryMessagesForAgent(input.historyMessages || [])

  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    DADOS_CLIENTE_KOMMO_MIRROR_SELECT,
  ).catch(() => null)
  const status = row?.[FORM_STATUS_FIELD] ?? null

  // CASO 1 — já estamos em "aguardando_confirm_polo_kommo": processa a resposta.
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO) {
    return handleConfirmaPoloKommoTurn(env, {
      telefone,
      userMessage,
      executionId,
      model,
      leadId: leadIdHint,
      pushName,
      t0,
      row,
    })
  }

  // Demais estados (aguardando polo, aguardando form, terminais) — deixa o
  // fluxo atual (tryHandlePoloPreFormFlow / Form Sumar / pós-form) cuidar.
  if (status && status !== '') return null

  // CASO 2 — lead pediu matrícula e ainda não temos status: avalia card.
  if (
    !messageConfirmsProceedToInscricaoForm(userMessage, historyMessages) &&
    !messageAsksForFormResend(userMessage)
  ) {
    return null
  }

  const idLead = await resolveLeadId(env, telefone, leadIdHint)
  if (!idLead) return null

  const mirror = await mirrorKommoCardToDadosCliente(env, { telefone, leadId: idLead })
  if (!mirror.ok || !mirror.snapshot) {
    console.log(
      `[${executionId || 'kommoCardExpress'}] EXPRESS skip telefone=${telefone} lead=${idLead} reason=${mirror.reason}`,
    )
    return null
  }

  const readiness = evaluateKommoExpressReadiness(mirror.snapshot)
  if (!readiness.ready) {
    console.log(
      `[${executionId || 'kommoCardExpress'}] EXPRESS skip lead=${idLead} missing=${readiness.missing.join(',')}`,
    )
    return null
  }

  const resolved = resolvePoloFromKommoSnapshot(mirror.snapshot, env)
  if (!resolved?.polo) {
    if (messageMentionsUnlistedPoloLocation(mirror.snapshot.polo_inscricao || '')) {
      console.log(
        `[${executionId || 'kommoCardExpress'}] EXPRESS polo_card_fora_lista=${mirror.snapshot.polo_inscricao}`,
      )
    }
    return null
  }

  await setStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO, idLead)
  await updateDadosCliente(env, {
    telefone,
    fields: {
      polo_inscricao_escolhido: resolved.polo.nome,
      captacao_unidade: resolved.unidade,
    },
  }).catch(() => {})

  const reply = buildConfirmaPoloKommoReply(resolved.polo.nome, { pushName })
  console.log(
    `[${executionId || 'kommoCardExpress'}] EXPRESS confirma_polo lead=${idLead} polo=${resolved.polo.id} unidade=${resolved.unidade}`,
  )

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps: [
        {
          type: 'kommo_card_express_confirma_polo',
          polo: resolved.polo.nome,
          unidade: resolved.unidade,
          source: resolved.source,
        },
      ],
      toolCalls: [],
      ctxSnapshot: {
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO,
        poloId: resolved.polo.id,
        poloNome: resolved.polo.nome,
        unidade: resolved.unidade,
        kommoCardExpress: true,
      },
    }),
  }
}

async function handleConfirmaPoloKommoTurn(env, ctx) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0, row } = ctx
  const idLead = await resolveLeadId(env, telefone, leadIdHint)

  const poloFromMessage = matchPoloFromUserMessage(userMessage)
  let resolvedPolo = null
  let resolvedUnidade = ''

  if (poloFromMessage) {
    resolvedPolo = poloFromMessage
    resolvedUnidade = resolvePoloUnidadeCode(poloFromMessage.id, env)
  } else if (leadConfirmsKeepPolo(userMessage)) {
    const dbPolo = String(row?.polo_inscricao_escolhido || row?.kommo_polo || '').trim()
    if (dbPolo) {
      const matched = matchPoloFromUserMessage(dbPolo)
      if (matched) {
        resolvedPolo = matched
        resolvedUnidade = resolvePoloUnidadeCode(matched.id, env)
      } else {
        resolvedPolo = { id: 'kommo_card', nome: dbPolo }
        resolvedUnidade = row?.captacao_unidade || ''
      }
    }
  } else if (leadDeclinesKeepPolo(userMessage)) {
    await setStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM, idLead)
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: buildPoloEscolhaPreFormMessage({ pushName }),
        steps: [{ type: 'kommo_card_express_decline_polo' }],
        ctxSnapshot: {
          inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
          kommoCardExpress: true,
        },
      }),
    }
  } else if (messageMentionsUnlistedPoloLocation(userMessage)) {
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: buildPoloOutroLocalidadeReply(),
        steps: [{ type: 'kommo_card_express_polo_fora_lista' }],
        ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO },
      }),
    }
  }

  if (!resolvedPolo) {
    // Resposta ambígua: repete pergunta canônica usando o polo já gravado.
    const poloAtual = String(row?.polo_inscricao_escolhido || row?.kommo_polo || '').trim() || 'o polo do seu cadastro'
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: buildConfirmaPoloKommoReply(poloAtual, { pushName }),
        steps: [{ type: 'kommo_card_express_ambiguo' }],
        ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO },
      }),
    }
  }

  // Polo confirmado/escolhido → executa captação direto (sem Form Sumar).
  await updateDadosCliente(env, {
    telefone,
    fields: {
      polo_inscricao_escolhido: resolvedPolo.nome,
      captacao_unidade: resolvedUnidade,
    },
  }).catch(() => {})

  // Refresh do snapshot Kommo + adiciona polo/unidade do banco para a captação.
  const refreshed = await mirrorKommoCardToDadosCliente(env, {
    telefone,
    leadId: idLead,
    force: true,
  }).catch(() => null)
  const snapshot = refreshed?.snapshot ? { ...refreshed.snapshot } : {}
  snapshot.unidade = resolvedUnidade
  snapshot.polo_inscricao = resolvedPolo.nome

  // Decisão `ux_inscrito = criar_novo`: força reuso ainda que já exista.
  const confirmedNovaInscricao = String(row?.kommo_status_inscricao || '')
    .toLowerCase()
    .includes('inscrito')

  const capRes = await executeCaptacaoAfterFormResolved(env, {
    telefone,
    idLead,
    executionId,
    model,
    pushName,
    t0,
    snapshotOverride: snapshot,
    confirmedNovaInscricao,
  }).catch((err) => ({ ok: false, error: err?.message || String(err) }))

  if (capRes?.ok && capRes.ctxForm === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) {
    console.log(
      `[${executionId || 'kommoCardExpress'}] EXPRESS ok lead=${idLead} polo=${resolvedPolo.nome} captacao_aceite`,
    )
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply:
          capRes.reply ||
          buildExpressAckSemLinkReply({ pushName }),
        steps: [
          { type: 'kommo_card_express_captacao', ok: true, polo: resolvedPolo.nome },
          ...(capRes.steps || []),
        ],
        toolCalls: capRes.toolCalls || [],
        ctxSnapshot: {
          inscricaoForm: capRes.ctxForm,
          iaPaused: true,
          contratoWhatsappSent: Boolean(capRes.contratoWhatsappSent),
          skipSchedulerWhatsapp: Boolean(capRes.skipSchedulerWhatsapp),
          kommoCardExpress: true,
        },
      }),
    }
  }

  // Falha de captação (curso indisponível, dados inválidos): grava
  // terminal `distribuir_consultor` para parar loops do scheduler e devolve
  // mensagem amigável.
  console.error(
    `[${executionId || 'kommoCardExpress'}] EXPRESS_FAIL lead=${idLead} ` +
      `polo=${resolvedPolo.nome} reason=${capRes?.error || 'sem_link'} ctxForm=${capRes?.ctxForm || 'n/a'}`,
  )
  await setStatus(env, telefone, INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR, idLead)

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      ok: false,
      reply:
        capRes?.reply ||
        buildDistribuirConsultorReply({ pushName, cursoNome: row?.kommo_curso || '' }),
      steps: [
        { type: 'kommo_card_express_captacao', ok: false, polo: resolvedPolo.nome },
        ...(capRes?.steps || []),
      ],
      toolCalls: capRes?.toolCalls || [],
      ctxSnapshot: {
        inscricaoForm: INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
        kommoCardExpress: true,
        kommoCardExpressFail: true,
      },
    }),
  }
}
