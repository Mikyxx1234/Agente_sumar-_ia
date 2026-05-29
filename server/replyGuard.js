/**
 * Output guard: valida o `reply` final antes de mandar pro lead.
 *
 * Princípio: o LLM NUNCA pode afirmar uma ação de inscrição (envio do
 * formulário, registro de polo, conclusão da matrícula) sem ter chamado
 * a tool correspondente neste turno. Se afirmar mesmo assim, o guard
 * substitui o texto por uma mensagem segura do servidor.
 *
 * Plugar antes do whatsappSender:
 *
 *   const verdict = validateReplyAgainstActions({ reply, toolCalls, stage })
 *   if (verdict.violation) {
 *     reply = verdict.safeReply
 *     telemetry.guard_violation = verdict.code
 *   }
 */

import { buildPoloEscolhaPreFormMessage } from '../libShared/sumarePoloCatalog.js'
import {
  DEFAULT_LGPD_SENSITIVE_REFUSAL,
  lgpdGuardEnabled,
  replyLeaksSensitiveCandidateData,
} from '../libShared/lgpdCompliance.js'

const PROMISE_FORM_SEND_RX =
  /\b(enviei|acabei de enviar|j[aá] enviei|j[aá] ativei|vou enviar|vou mandar|pode aguardar|aguarde um momento|em instantes (vou|envio))\b[\s\S]{0,80}\bformul[aá]rio\b/i

const FORM_SENT_AFFIRMATION_RX =
  /\b(enviei|acabei de enviar|j[aá] enviei|j[aá] ativei)\b[\s\S]{0,80}\bformul[aá]rio\b/i

const POLO_REGISTERED_RX =
  /\b(polo|p[oó]lo)\b[\s\S]{0,40}\b(registrad[oa]|anotad[oa]|confirmad[oa]|salv[oa])\b/i

const INSCRICAO_DONE_RX =
  /\b(inscri[cç][aã]o|matr[ií]cula)\b[\s\S]{0,40}\b(registrada|concluid[ao]|iniciad[ao]|feita|finalizad[ao]|j[aá] foi feita|registrei)\b/i

const CAPTACAO_DONE_RX =
  /\b(cadastr(?:o|amos)|cadastrei|inscrev(?:i|emos)|registrei sua inscri[cç][aã]o)\b/i

const ACTION_TOOL_NAMES = new Set([
  'enviar_form_sumar_inscricao',
  'registrar_polo_inscricao',
  'confirmar_recebimento_formulario',
])

function toolWasCalledOk(toolCalls, names) {
  const list = Array.isArray(toolCalls) ? toolCalls : []
  return list.some((tc) => {
    const name = tc?.tool || tc?.name || tc?.function?.name
    if (!name || !names.includes(name)) return false
    if (tc.ok === false) return false
    if (tc.actionOk === false) return false
    return true
  })
}

function safeReplyForStage(stage) {
  if (stage === 'aguardando_escolha_polo_pre_form') {
    return buildPoloEscolhaPreFormMessage({})
  }
  if (stage === 'aguardando_form_sumar' || stage === 'aguardando_distribuicao_form') {
    return (
      'Já ativei o envio do formulário de inscrição por aqui. Quando terminar de preencher e enviar, nossa equipe segue com você automaticamente. Precisa de ajuda com algum campo?'
    )
  }
  if (stage === 'aguardando_aceite_contrato') {
    return (
      'Sua inscrição já está registrada e enviei o link do contrato por aqui. Acesse o link, leia e clique em ASSINAR CONTRATO para concluir, tudo bem?'
    )
  }
  if (stage === 'form_sumar_concluido') {
    return (
      'Sua inscrição já está concluída por aqui. Em breve um consultor da Faculdade Sumaré entra em contato para os próximos passos.'
    )
  }
  // Sem stage definido → pede polo para começar o fluxo.
  return buildPoloEscolhaPreFormMessage({})
}

/**
 * @param {object} params
 * @param {string} params.reply         texto final do LLM (msg.content) prestes a ir pro lead
 * @param {Array}  params.toolCalls     toolTrace do turno (cada item tem `tool` + `ok`/`actionOk`)
 * @param {string} [params.stage]       inscricao_form_status atual (ou null)
 * @returns {{ violation: boolean, code?: string, safeReply?: string, original?: string }}
 */
export function validateReplyAgainstActions({ reply, toolCalls = [], stage = null } = {}) {
  const text = String(reply || '')
  if (!text || text.length < 4) return { violation: false }

  // Reply afirma que enviou o formulário?
  if (FORM_SENT_AFFIRMATION_RX.test(text) || PROMISE_FORM_SEND_RX.test(text)) {
    if (!toolWasCalledOk(toolCalls, ['enviar_form_sumar_inscricao', 'registrar_polo_inscricao'])) {
      return {
        violation: true,
        code: 'promise_form_send_without_tool',
        safeReply: safeReplyForStage(stage),
        original: text,
      }
    }
  }

  // Reply afirma que registrou polo?
  if (POLO_REGISTERED_RX.test(text)) {
    if (!toolWasCalledOk(toolCalls, ['registrar_polo_inscricao'])) {
      return {
        violation: true,
        code: 'polo_registered_without_tool',
        safeReply: safeReplyForStage(stage),
        original: text,
      }
    }
  }

  // Reply afirma que registrou inscrição/matrícula concluída?
  if (INSCRICAO_DONE_RX.test(text) || CAPTACAO_DONE_RX.test(text)) {
    if (!toolWasCalledOk(toolCalls, ['confirmar_recebimento_formulario'])) {
      return {
        violation: true,
        code: 'inscricao_done_without_tool',
        safeReply: safeReplyForStage(stage),
        original: text,
      }
    }
  }

  return { violation: false }
}

/**
 * Bloqueia respostas que vazam dados sensíveis de candidatos (LGPD).
 * @param {object} params
 * @param {string} params.reply
 * @param {string} [params.userMessage]
 * @param {Record<string,string>} [params.env]
 */
export function validateReplyLgpd({ reply, userMessage = '', env = process.env } = {}) {
  if (!lgpdGuardEnabled(env)) return { violation: false }
  const text = String(reply || '')
  if (!text || text.length < 4) return { violation: false }
  const check = replyLeaksSensitiveCandidateData(text, { userMessage })
  if (!check.leak) return { violation: false }
  return {
    violation: true,
    code: check.code,
    safeReply: DEFAULT_LGPD_SENSITIVE_REFUSAL,
    original: text,
  }
}

/** Valida guard de ações + LGPD em sequência. */
export function validateReplyBeforeSend({ reply, toolCalls = [], stage = null, userMessage = '', env = process.env } = {}) {
  const actionVerdict = validateReplyAgainstActions({ reply, toolCalls, stage })
  if (actionVerdict.violation) return actionVerdict
  return validateReplyLgpd({ reply, userMessage, env })
}

/** Para testes/inspeção: lista as regex usadas. */
export const REPLY_GUARD_PATTERNS = {
  promiseFormSend: PROMISE_FORM_SEND_RX,
  formSentAffirmation: FORM_SENT_AFFIRMATION_RX,
  poloRegistered: POLO_REGISTERED_RX,
  inscricaoDone: INSCRICAO_DONE_RX,
  captacaoDone: CAPTACAO_DONE_RX,
}

export const REPLY_GUARD_ACTION_TOOL_NAMES = ACTION_TOOL_NAMES
