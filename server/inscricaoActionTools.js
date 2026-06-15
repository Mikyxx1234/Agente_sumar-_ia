/**
 * Executores das tools de ação de inscrição.
 *
 * Princípio: o LLM **invoca** uma destas tools quando quer disparar uma ação;
 * o servidor executa e devolve um **texto canônico** (`replyOverride`) que
 * substitui qualquer narrativa do LLM no turno. Assim a resposta que chega ao
 * lead nunca diverge da ação que realmente aconteceu.
 *
 * Cada tool grava `inscricao_form_status` ANTES de qualquer disparo
 * (salesbot/captação) — transição atômica, à prova de reentrância.
 *
 * Retorno padrão:
 *   {
 *     ok:        boolean,         // ação concluída com sucesso
 *     code:      string,          // FORM_SENT_OK | POLO_NEEDED | ...
 *     text:      string,          // mensagem curta para o LLM (tool message)
 *     replyOverride: string,      // mensagem definitiva para o lead (sobrescreve LLM)
 *     ctxSnapshot:  object,       // estado p/ telemetria
 *     steps:        array,        // passos p/ orchestratorSteps
 *   }
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  buildInscricaoFormSentReply,
  buildFormAwaitingFillReply,
  shouldBlockFormularioSumResend,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  SUMARE_POLOS_EAD,
  resolvePoloUnidadeCode,
  buildPoloEscolhaPreFormMessage,
  buildPoloEscolhidoAckReply,
  buildPoloConfirmacaoInvalidaReply,
  matchPoloFromUserMessage,
  resolvePoloFromKommoSnapshot,
} from '../libShared/sumarePoloCatalog.js'
import {
  ensureDadosClienteRow,
  fetchDadosClienteByTelefone,
  getLeadIdByTelefone,
} from './dadosClienteStore.js'
import { findLeadByPhone } from './kommoClient.js'
import { resolveTransferenciaCursoCodigo } from './sumareCaptacaoClient.js'
import { deliverInscricaoForm } from './inscricaoFormFlow.js'
import { executeCaptacaoAfterFormResolved } from './inscricaoPostFormPipeline.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import { DADOS_CLIENTE_FORM_GUARD_SELECT } from './dadosClienteInscricaoFields.js'
import { gateMatriculaConfirmacaoBeforeForm } from './inscricaoMatriculaConfirmFlow.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

function resolvePoloEntry(poloId) {
  if (!poloId) return null
  const id = String(poloId).trim().toLowerCase()
  return SUMARE_POLOS_EAD.find((p) => p.id === id) || matchPoloFromUserMessage(id)
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

/**
 * Resolve polo já gravado em Supabase ou no card Kommo (não força fallback).
 * @returns {{ poloNome: string, unidade: string, source: string } | null}
 */
async function resolveExistingPolo(env, { telefone, leadId }) {
  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    `${FORM_STATUS_FIELD},polo_inscricao_escolhido,captacao_unidade`,
  )
  const poloNome = String(row?.polo_inscricao_escolhido || '').trim()
  const unidade = String(row?.captacao_unidade || '').trim()
  if (poloNome && unidade) return { poloNome, unidade, source: 'supabase' }
  if (leadId != null) {
    const snap = await fetchLeadFormSnapshot(env, leadId).catch(() => ({ ok: false }))
    if (snap.ok && snap.snapshot) {
      const resolved = resolvePoloFromKommoSnapshot(snap.snapshot, env)
      if (resolved) {
        return { poloNome: resolved.polo.nome, unidade: resolved.unidade, source: resolved.source }
      }
    }
  }
  return null
}

async function gravarPoloEStatusAguardando(env, { telefone, leadId, polo, unidade }) {
  return ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: {
      polo_inscricao_escolhido: polo.nome,
      captacao_unidade: unidade,
      [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_AGUARDANDO,
    },
  })
}

async function gravarStatus(env, { telefone, leadId, status }) {
  return ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: { [FORM_STATUS_FIELD]: status },
  })
}

/** Tool: `enviar_form_sumar_inscricao`. */
export async function runEnviarFormSumarInscricao(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const curso = String(args.curso || '').trim()
  const poloId = args.polo_id ? String(args.polo_id).trim().toLowerCase() : null
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'enviar_form_sumar_inscricao', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const leadId = await resolveLeadId(env, telefone, ctx.leadId)

  const guardRow = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_FORM_GUARD_SELECT)
  if (shouldBlockFormularioSumResend(guardRow)) {
    const status = guardRow?.[FORM_STATUS_FIELD] ?? null
    const reply =
      status === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
        ? 'Já recebemos seu formulário e enviamos o link para concluir a matrícula. Se precisar do link de pagamento de novo, é só pedir por aqui.'
        : buildFormAwaitingFillReply({ pushName })
    return {
      ok: true,
      code: 'FORM_ALREADY_SENT',
      text: 'Formulário já enviado ou inscrição já avançou — não reativar Formulario_Sum.',
      replyOverride: reply,
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: status || 'blocked_resend',
        blockedResend: true,
      },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: true, code: 'FORM_ALREADY_SENT' }],
    }
  }

  let polo = null
  let unidade = null
  if (poloId) {
    const entry = resolvePoloEntry(poloId)
    if (!entry) {
      const reply = buildPoloConfirmacaoInvalidaReply()
      await gravarStatus(env, { telefone, leadId, status: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM }).catch(() => {})
      return {
        ok: false,
        code: 'INVALID_POLO',
        text: `polo_id inválido: ${poloId}. Use sao_miguel | barra_funda | tatuape | santana | pinheiros.`,
        replyOverride: reply,
        ctxSnapshot: {
          inscricaoActionTool: 'enviar_form_sumar_inscricao',
          inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
          poloIdInformado: poloId,
        },
        steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'INVALID_POLO' }],
      }
    }
    polo = entry
    unidade = resolvePoloUnidadeCode(polo.id, env)
  } else {
    const existing = await resolveExistingPolo(env, { telefone, leadId })
    if (existing) {
      const matched = matchPoloFromUserMessage(existing.poloNome)
      polo = matched || { id: 'supabase', nome: existing.poloNome, endereco: '' }
      unidade = existing.unidade
    }
  }

  if (!polo) {
    await gravarStatus(env, {
      telefone,
      leadId,
      status: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
    }).catch(() => {})
    const reply = buildPoloEscolhaPreFormMessage({ pushName })
    return {
      ok: false,
      code: 'POLO_NEEDED',
      text: 'Polo ainda não definido — pedi escolha de polo (1-5) ao lead. NÃO afirme que enviou o formulário.',
      replyOverride: reply,
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
        curso,
      },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'POLO_NEEDED' }],
    }
  }

  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: {
      polo_inscricao_escolhido: polo.nome,
      captacao_unidade: unidade,
    },
  }).catch(() => {})

  const matriculaGate = await gateMatriculaConfirmacaoBeforeForm(env, {
    telefone,
    userMessage: '',
    historyMessages: ctx.historyMessages || [],
    leadId,
    cursoHint: curso,
    executionId: ctx.executionId,
    model: ctx.model,
    pushName,
    t0: Date.now(),
  })
  if (!matriculaGate.proceed) {
    if (matriculaGate.handled) {
      const reply = matriculaGate.result?.reply || ''
      return {
        ok: true,
        code: 'MATRICULA_RESUMO_PENDING',
        text: 'Resumo de matrícula enviado — aguardar autorização do lead antes do formulário.',
        replyOverride: reply,
        ctxSnapshot: {
          inscricaoActionTool: 'enviar_form_sumar_inscricao',
          inscricaoForm: matriculaGate.result?.ctxSnapshot?.inscricaoForm,
          poloId: polo.id,
          unidade,
        },
        steps: [
          { type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: true, code: 'MATRICULA_RESUMO_PENDING' },
          ...(matriculaGate.result?.orchestratorSteps || []),
        ],
      }
    }
    return {
      ok: false,
      code: 'MATRICULA_AUTHORIZATION_PENDING',
      text: 'Lead ainda não autorizou o resumo de matrícula — não enviar formulário.',
      replyOverride:
        'Antes de seguir com o formulário, preciso da sua autorização sobre as condições da matrícula que enviei. Você autoriza a conclusão da matrícula?',
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: 'aguardando_autorizacao_matricula',
        poloId: polo.id,
      },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'MATRICULA_AUTHORIZATION_PENDING' }],
    }
  }

  await gravarPoloEStatusAguardando(env, { telefone, leadId, polo, unidade }).catch(() => {})

  const delivery = await deliverInscricaoForm(env, {
    telefone,
    leadId,
    executionId: ctx.executionId,
    forceResend: false,
  })
  const sendOk = Boolean(delivery.result?.ok)

  if (!sendOk) {
    return {
      ok: false,
      code: delivery.result?.code || 'FORM_SEND_FAILED',
      text: `Falha ao disparar Form Sumar: ${delivery.result?.error || delivery.result?.code || 'erro'}.`,
      replyOverride:
        'Queremos muito te ajudar com a inscrição na Faculdade Sumaré! No momento não consegui abrir o formulário automático no WhatsApp — um consultor entrará em contato em breve por aqui.',
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
        delivery: delivery.delivery,
        poloId: polo.id,
        unidade,
        error: delivery.result?.error,
      },
      steps: [
        {
          type: 'tool_action',
          tool: 'enviar_form_sumar_inscricao',
          ok: false,
          code: delivery.result?.code || 'FORM_SEND_FAILED',
          delivery: delivery.delivery,
        },
      ],
    }
  }

  const reply = buildInscricaoFormSentReply({ pushName, resend: false })
  return {
    ok: true,
    code: 'FORM_SENT_OK',
    text: `Form Sumar disparado (delivery=${delivery.delivery}). Estado: ${INSCRICAO_FORM_STATUS_AGUARDANDO}.`,
    replyOverride: reply,
    ctxSnapshot: {
      inscricaoActionTool: 'enviar_form_sumar_inscricao',
      inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
      delivery: delivery.delivery,
      poloId: polo.id,
      poloNome: polo.nome,
      unidade,
      curso,
    },
    steps: [
      {
        type: 'tool_action',
        tool: 'enviar_form_sumar_inscricao',
        ok: true,
        delivery: delivery.delivery,
        bot_id: delivery.result?.botId,
        polo: polo.id,
      },
    ],
  }
}

/**
 * Tool: `registrar_transferencia`.
 * Ingresso por transferência externa / aproveitamento de matérias: grava os 3
 * campos extras (curso de origem, semestre concluído, curso desejado) e segue
 * para o mesmo fluxo de polo + Form Sumar do vestibular. A geração na API
 * Captação usa tipoIngresso=Transferencia_Ext (montado no pós-formulário).
 */
export async function runRegistrarTransferencia(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const cursoOrigemRaw = String(args.curso_origem || '').trim()
  const semestreRaw = String(args.semestre_concluido || '').trim()
  const cursoDesejadoRaw = String(args.curso_desejado || '').trim()
  const poloId = args.polo_id ? String(args.polo_id).trim().toLowerCase() : null
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'registrar_transferencia', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'registrar_transferencia', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const faltando = []
  if (!cursoOrigemRaw) faltando.push('curso de origem (o que você cursou/cursa)')
  if (!semestreRaw) faltando.push('último semestre concluído')
  if (!cursoDesejadoRaw) faltando.push('curso desejado na Sumaré')
  if (faltando.length) {
    return {
      ok: false,
      code: 'TRANSFERENCIA_DADOS_FALTANDO',
      text: `Faltam dados da transferência: ${faltando.join(', ')}. Pergunte ao lead.`,
      replyOverride: `Para dar entrada pela transferência/aproveitamento de matérias, me confirme: ${faltando.join(', ')}.`,
      ctxSnapshot: { inscricaoActionTool: 'registrar_transferencia', faltando },
      steps: [{ type: 'tool_action', tool: 'registrar_transferencia', ok: false, code: 'TRANSFERENCIA_DADOS_FALTANDO' }],
    }
  }

  const [origem, destino] = await Promise.all([
    resolveTransferenciaCursoCodigo(env, cursoOrigemRaw),
    resolveTransferenciaCursoCodigo(env, cursoDesejadoRaw),
  ])

  if (!destino) {
    return {
      ok: false,
      code: 'CURSO_DESTINO_INVALIDO',
      text: `Curso desejado "${cursoDesejadoRaw}" não encontrado na lista EAD oficial. Peça o nome correto do curso.`,
      replyOverride: `Não localizei o curso "${cursoDesejadoRaw}" na nossa lista EAD. Pode confirmar o nome do curso que você quer cursar na Sumaré?`,
      ctxSnapshot: { inscricaoActionTool: 'registrar_transferencia', cursoDesejadoRaw },
      steps: [{ type: 'tool_action', tool: 'registrar_transferencia', ok: false, code: 'CURSO_DESTINO_INVALIDO' }],
    }
  }
  if (!origem) {
    return {
      ok: false,
      code: 'CURSO_ORIGEM_INVALIDO',
      text: `Curso de origem "${cursoOrigemRaw}" não bateu com a lista EAD oficial. Confirme o nome do curso anterior.`,
      replyOverride: `Só pra confirmar: qual era exatamente o nome do curso que você cursou/está cursando? Não consegui identificar "${cursoOrigemRaw}".`,
      ctxSnapshot: { inscricaoActionTool: 'registrar_transferencia', cursoOrigemRaw },
      steps: [{ type: 'tool_action', tool: 'registrar_transferencia', ok: false, code: 'CURSO_ORIGEM_INVALIDO' }],
    }
  }

  const semestre = semestreRaw.replace(/\D/g, '')
  const leadId = await resolveLeadId(env, telefone, ctx.leadId)

  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: {
      transferencia_curso_origem: origem.codigo,
      transferencia_semestre: semestre || semestreRaw,
      transferencia_curso_destino: destino.codigo,
    },
  }).catch(() => {})

  // Mesmo fluxo do vestibular: pede polo (se preciso), gate de matrícula e Form Sumar.
  // O pós-formulário lê as colunas de transferência e gera com Transferencia_Ext.
  return runEnviarFormSumarInscricao(
    env,
    { telefone, curso: destino.descricao, polo_id: poloId },
    ctx,
  )
}

/** Tool: `registrar_polo_inscricao`. */
export async function runRegistrarPoloInscricao(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const poloId = String(args.polo_id || '').trim().toLowerCase()
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'registrar_polo_inscricao', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const polo = resolvePoloEntry(poloId)
  if (!polo) {
    return {
      ok: false,
      code: 'INVALID_POLO',
      text: `polo_id inválido: "${poloId}". Use sao_miguel | barra_funda | tatuape | santana | pinheiros.`,
      replyOverride: buildPoloConfirmacaoInvalidaReply(),
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
        poloIdInformado: poloId,
      },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: false, code: 'INVALID_POLO' }],
    }
  }

  const leadId = await resolveLeadId(env, telefone, ctx.leadId)
  const unidade = resolvePoloUnidadeCode(polo.id, env)

  const guardRow = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_FORM_GUARD_SELECT)
  if (shouldBlockFormularioSumResend(guardRow)) {
    return {
      ok: true,
      code: 'FORM_ALREADY_SENT',
      text: 'Polo reconhecido, mas formulário já foi enviado — não reativar Formulario_Sum.',
      replyOverride: buildFormAwaitingFillReply({ pushName }),
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: guardRow?.[FORM_STATUS_FIELD] || 'blocked_resend',
        poloId: polo.id,
        blockedResend: true,
      },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: true, code: 'FORM_ALREADY_SENT' }],
    }
  }

  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: {
      polo_inscricao_escolhido: polo.nome,
      captacao_unidade: unidade,
    },
  }).catch(() => {})

  // Transferência: o polo chega em um turno separado do registrar_transferencia,
  // então o curso desejado (destino) não está na conversa deste turno — e o lead
  // citou DOIS cursos (origem + destino), o que confunde a heurística do resumo.
  // Resolvemos o nome humano do destino persistido p/ usar como cursoHint e o
  // resumo de matrícula mostrar o curso CERTO (o que o lead vai cursar na Sumaré).
  let cursoHint
  try {
    const transfRow = await fetchDadosClienteByTelefone(env, telefone, 'transferencia_curso_destino')
    if (transfRow?.transferencia_curso_destino) {
      const dest = await resolveTransferenciaCursoCodigo(env, transfRow.transferencia_curso_destino)
      cursoHint = dest?.descricao || undefined
    }
  } catch {
    /* sem hint: gate cai na heurística da conversa (fluxo vestibular normal) */
  }

  const matriculaGate = await gateMatriculaConfirmacaoBeforeForm(env, {
    telefone,
    userMessage: String(args.polo_id || ''),
    historyMessages: ctx.historyMessages || [],
    leadId,
    cursoHint,
    executionId: ctx.executionId,
    model: ctx.model,
    pushName,
    t0: Date.now(),
  })
  if (!matriculaGate.proceed) {
    if (matriculaGate.handled) {
      const reply = matriculaGate.result?.reply || ''
      return {
        ok: true,
        code: 'MATRICULA_RESUMO_PENDING',
        text: 'Polo registrado; resumo de matrícula enviado — aguardar autorização antes do formulário.',
        replyOverride: reply,
        ctxSnapshot: {
          inscricaoActionTool: 'registrar_polo_inscricao',
          inscricaoForm: matriculaGate.result?.ctxSnapshot?.inscricaoForm,
          poloId: polo.id,
          unidade,
        },
        steps: [
          { type: 'tool_action', tool: 'registrar_polo_inscricao', ok: true, code: 'MATRICULA_RESUMO_PENDING' },
          ...(matriculaGate.result?.orchestratorSteps || []),
        ],
      }
    }
    return {
      ok: false,
      code: 'MATRICULA_AUTHORIZATION_PENDING',
      text: 'Lead ainda não autorizou o resumo de matrícula — não enviar formulário.',
      replyOverride:
        'Antes de seguir com o formulário, preciso da sua autorização sobre as condições da matrícula que enviei. Você autoriza a conclusão da matrícula?',
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: 'aguardando_autorizacao_matricula',
        poloId: polo.id,
      },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: false, code: 'MATRICULA_AUTHORIZATION_PENDING' }],
    }
  }

  await gravarPoloEStatusAguardando(env, { telefone, leadId, polo, unidade }).catch(() => {})

  const delivery = await deliverInscricaoForm(env, {
    telefone,
    leadId,
    executionId: ctx.executionId,
    forceResend: false,
  })
  const sendOk = Boolean(delivery.result?.ok)

  if (!sendOk) {
    return {
      ok: false,
      code: delivery.result?.code || 'FORM_SEND_FAILED',
      text: `Polo ${polo.nome} gravado, mas falha ao disparar Form Sumar: ${delivery.result?.error || delivery.result?.code || 'erro'}.`,
      replyOverride:
        `Anotamos o polo *${polo.nome}*. No momento não consegui abrir o formulário automático aqui no WhatsApp — um consultor da Faculdade Sumaré entrará em contato em breve por aqui.`,
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
        poloId: polo.id,
        poloNome: polo.nome,
        unidade,
        delivery: delivery.delivery,
        error: delivery.result?.error,
      },
      steps: [
        {
          type: 'tool_action',
          tool: 'registrar_polo_inscricao',
          ok: false,
          code: delivery.result?.code || 'FORM_SEND_FAILED',
          polo: polo.id,
        },
      ],
    }
  }

  const reply = buildPoloEscolhidoAckReply(polo, { pushName })
  return {
    ok: true,
    code: 'POLO_REGISTRADO_OK',
    text: `Polo ${polo.nome} (${unidade}) gravado e Form Sumar disparado (delivery=${delivery.delivery}). Estado: ${INSCRICAO_FORM_STATUS_AGUARDANDO}.`,
    replyOverride: reply,
    ctxSnapshot: {
      inscricaoActionTool: 'registrar_polo_inscricao',
      inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
      poloId: polo.id,
      poloNome: polo.nome,
      unidade,
      delivery: delivery.delivery,
    },
    steps: [
      {
        type: 'tool_action',
        tool: 'registrar_polo_inscricao',
        ok: true,
        polo: polo.id,
        unidade,
        delivery: delivery.delivery,
        bot_id: delivery.result?.botId,
      },
    ],
  }
}

/** Tool: `confirmar_recebimento_formulario`. */
export async function runConfirmarRecebimentoFormulario(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'confirmar_recebimento_formulario', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const leadId = await resolveLeadId(env, telefone, ctx.leadId)
  if (leadId == null) {
    return {
      ok: false,
      code: 'LEAD_NOT_FOUND',
      text: 'Não consegui localizar o lead no Kommo para concluir a inscrição. Encaminhe para consultor.',
      replyOverride:
        'Recebi seu formulário! Para seguir, preciso localizar seu cadastro — em instantes um consultor da Faculdade Sumaré fala com você por aqui, tudo bem?',
      ctxSnapshot: { inscricaoActionTool: 'confirmar_recebimento_formulario', leadNotFound: true },
      steps: [
        { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: false, code: 'LEAD_NOT_FOUND' },
      ],
    }
  }

  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    `${FORM_STATUS_FIELD},polo_inscricao_escolhido,captacao_unidade,captacao_candidato_id`,
  )
  const status = row?.[FORM_STATUS_FIELD] ?? null
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO || row?.captacao_candidato_id) {
    return {
      ok: true,
      code: 'ALREADY_PROCESSED',
      text: `Inscrição já processada (status=${status || 'concluido'}). Não dispare de novo.`,
      replyOverride:
        'Já recebemos seu formulário e iniciamos sua inscrição. Em breve nossa equipe segue com você por aqui para finalizar, tudo bem?',
      ctxSnapshot: {
        inscricaoActionTool: 'confirmar_recebimento_formulario',
        inscricaoForm: status || 'concluido',
        alreadyProcessed: true,
      },
      steps: [
        { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: true, code: 'ALREADY_PROCESSED' },
      ],
    }
  }

  let snapshotOverride = null
  const unidadeDb = String(row?.captacao_unidade || '').trim()
  const poloDb = String(row?.polo_inscricao_escolhido || '').trim()
  if (unidadeDb && poloDb) {
    const snapRes = await fetchLeadFormSnapshot(env, leadId).catch(() => ({ ok: false }))
    const snapshot = snapRes.ok ? { ...snapRes.snapshot } : {}
    snapshot.unidade = unidadeDb
    snapshot.polo_inscricao = poloDb
    snapshotOverride = snapshot
  }

  const cap = await executeCaptacaoAfterFormResolved(env, {
    telefone,
    idLead: leadId,
    executionId: ctx.executionId,
    model: ctx.model,
    pushName,
    t0: ctx.t0 || Date.now(),
    snapshotOverride,
    confirmedNovaInscricao: Boolean(ctx.confirmedNovaInscricao),
    useCandidatoId: ctx.useCandidatoId,
  })

  if (cap.ok) {
    return {
      ok: true,
      code: 'INSCRICAO_REGISTRADA_OK',
      text: `Inscrição na API Sumaré OK. Estado: ${cap.ctxForm}.`,
      replyOverride: cap.reply,
      ctxSnapshot: {
        inscricaoActionTool: 'confirmar_recebimento_formulario',
        inscricaoForm: cap.ctxForm,
        sumareCaptacao: true,
        contratoWhatsappSent: Boolean(cap.contratoWhatsappSent),
        skipSchedulerWhatsapp: Boolean(cap.skipSchedulerWhatsapp),
      },
      steps: [
        { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: true, code: 'INSCRICAO_REGISTRADA_OK' },
        ...(cap.steps || []),
      ],
      toolCalls: cap.toolCalls || [],
    }
  }

  return {
    ok: false,
    code: 'CAPTACAO_FAILED',
    text: 'Falha ao registrar inscrição na API Sumaré. Reply servidor já trata o fallback.',
    replyOverride: cap.reply,
    ctxSnapshot: {
      inscricaoActionTool: 'confirmar_recebimento_formulario',
      inscricaoForm: cap.ctxForm,
      captacaoFailed: true,
    },
    steps: [
      { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: false, code: 'CAPTACAO_FAILED' },
      ...(cap.steps || []),
    ],
    toolCalls: cap.toolCalls || [],
  }
}
