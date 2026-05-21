/**
 * Endpoints de teste do fluxo Captação Sumaré (antes de commit / produção).
 * Exige SUMARE_CAPTACAO_TEST_ALLOW=true
 */

import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import {
  isSumareCaptacaoEnabled,
  buildGerarCandidatoQuery,
  validateGerarCandidatoParams,
  buildContratoPortalUrl,
  runCaptacaoContratoWorkflow,
  gerarCandidatoIngresso,
  consultarStatusCandidato,
  solicitarAceiteContrato,
  extractCandidatoId,
} from './sumareCaptacaoClient.js'
import { runMatriculaCaptacaoAfterForm } from './matriculaCaptacaoPipeline.js'
import { buildContratoAceiteLinkReply } from '../libShared/inscricaoFormHeuristics.js'

export function isCaptacaoTestAllowed(env = process.env) {
  return ['true', '1', 'yes'].includes(
    String(env.SUMARE_CAPTACAO_TEST_ALLOW || '').trim().toLowerCase(),
  )
}

export function getCaptacaoDiagnose(env = process.env) {
  const enabled = isSumareCaptacaoEnabled(env)
  const testAllow = isCaptacaoTestAllowed(env)
  const tokenSet = Boolean(
    String(env.SUMARE_CAPTACAO_TOKEN || env.SUMARE_CAPTACAO_BEARER || '').trim(),
  )
  return {
    ok: true,
    captacaoEnabled: enabled,
    testEndpointsAllowed: testAllow,
    config: {
      baseUrl: env.SUMARE_CAPTACAO_BASE_URL || 'https://api-captacao.sumare.edu.br',
      portalUrl: env.SUMARE_CONTRATO_PORTAL_URL || 'https://sumare.edu.br/vem-pra-sumare/vestibular/contrato',
      unidadeDefault: env.SUMARE_CAPTACAO_UNIDADE_DEFAULT || 'ED_SP_P5',
      turnoDefault: env.SUMARE_CAPTACAO_TURNO_DEFAULT || 'EAD',
      cursoDefault: env.SUMARE_CAPTACAO_CURSO_DEFAULT || '',
      tokenConfigured: tokenSet,
      runSalesbot49813: env.SUMARE_CAPTACAO_RUN_SALESBOT_49813 || 'false',
    },
    testRoutes: {
      diagnose: 'GET /api/inscricao/captacao/diagnose',
      dryRun: 'POST /api/inscricao/captacao/test-workflow { "dryRun": true, "leadId": N, "telefone": "5511..." }',
      full: 'POST /api/inscricao/captacao/test-workflow { "leadId": N, "telefone": "5511...", "sendWhatsapp": false }',
      stepGerar: 'POST /api/inscricao/captacao/test-step/gerar',
      stepStatus: 'POST /api/inscricao/captacao/test-step/status { "candidatoId": "..." }',
      stepAceite: 'POST /api/inscricao/captacao/test-step/aceite { "candidatoId": "..." }',
      pipeline: 'POST /api/inscricao/captacao/test-pipeline { "leadId": N, "telefone": "5511...", "sendWhatsapp": true }',
    },
  }
}

async function resolveSnapshot(env, body) {
  if (body?.snapshot && typeof body.snapshot === 'object') {
    return { ok: true, snapshot: body.snapshot, source: 'body' }
  }
  const leadId = Number(body?.leadId ?? body?.id_lead ?? body?.idLead)
  if (Number.isFinite(leadId) && leadId > 0) {
    const snap = await fetchLeadFormSnapshot(env, leadId)
    if (!snap.ok) return { ok: false, error: snap.error || 'kommo_snapshot_failed' }
    return { ok: true, snapshot: snap.snapshot, source: 'kommo', leadId }
  }
  return {
    ok: false,
    error: 'Informe leadId (Kommo) ou snapshot no body (cpf, email, nome, curso_inscricao, data_nasc, sexo, ...)',
  }
}

/**
 * dryRun: só monta params e URLs, sem chamar API Sumaré.
 */
export async function runCaptacaoTestWorkflow(env, body = {}) {
  const telefone = body.telefone || body.phone || ''
  const snapRes = await resolveSnapshot(env, body)
  if (!snapRes.ok) return { ok: false, code: 'SNAPSHOT_ERROR', error: snapRes.error }

  const params = buildGerarCandidatoQuery(snapRes.snapshot, telefone, env)
  const missing = validateGerarCandidatoParams(params)
  const previewUrl = buildContratoPortalUrl(env, body.candidatoId || 'CANDIDATO_ID_EXEMPLO')

  if (body.dryRun) {
    return {
      ok: missing.length === 0,
      dryRun: true,
      snapshotSource: snapRes.source,
      leadId: snapRes.leadId,
      gerarParams: params,
      missingFields: missing,
      previewContratoUrl: previewUrl,
      previewWhatsappMessage: buildContratoAceiteLinkReply({
        pushName: body.pushName || params.nomeCompl,
        contractUrl: previewUrl,
      }),
    }
  }

  if (!isSumareCaptacaoEnabled(env)) {
    return {
      ok: false,
      code: 'CAPTACAO_DISABLED',
      error: 'Defina SUMARE_CAPTACAO_ENABLED=true e SUMARE_CAPTACAO_TOKEN',
      gerarParams: params,
      missingFields: missing,
    }
  }

  if (missing.length) {
    return { ok: false, code: 'MISSING_FIELDS', missingFields: missing, gerarParams: params }
  }

  const workflow = await runCaptacaoContratoWorkflow(env, {
    snapshot: snapRes.snapshot,
    telefone,
  })

  return {
    ok: workflow.ok,
    snapshotSource: snapRes.source,
    leadId: snapRes.leadId,
    gerarParams: params,
    ...workflow,
    previewWhatsappMessage: workflow.contractUrl
      ? buildContratoAceiteLinkReply({
          pushName: body.pushName,
          contractUrl: workflow.contractUrl,
        })
      : null,
    sendWhatsapp: Boolean(body.sendWhatsapp),
  }
}

export async function runCaptacaoTestStep(env, step, body = {}) {
  if (!isSumareCaptacaoEnabled(env)) {
    return { ok: false, code: 'CAPTACAO_DISABLED', error: 'Captação não configurada' }
  }
  if (step === 'gerar') {
    const snapRes = await resolveSnapshot(env, body)
    if (!snapRes.ok) return { ok: false, error: snapRes.error }
    const params = buildGerarCandidatoQuery(snapRes.snapshot, body.telefone, env)
    const missing = validateGerarCandidatoParams(params)
    if (missing.length) return { ok: false, code: 'MISSING_FIELDS', missingFields: missing, params }
    const r = await gerarCandidatoIngresso(env, params)
    const candidatoId = extractCandidatoId(r.data)
    return {
      ok: r.ok,
      step: 'gerar',
      status: r.status,
      params,
      candidatoId,
      data: r.data,
      raw: r.raw,
      contratoUrl: candidatoId ? buildContratoPortalUrl(env, candidatoId) : null,
    }
  }
  if (step === 'status') {
    const id = body.candidatoId || body.candidato
    if (!id) return { ok: false, error: 'candidatoId obrigatório' }
    const r = await consultarStatusCandidato(env, id)
    return { ok: r.ok, step: 'status', status: r.status, candidatoId: id, data: r.data, raw: r.raw }
  }
  if (step === 'aceite') {
    const id = body.candidatoId || body.candidato
    if (!id) return { ok: false, error: 'candidatoId obrigatório' }
    const r = await solicitarAceiteContrato(env, id)
    const contractUrl = buildContratoPortalUrl(env, id)
    return {
      ok: r.ok,
      step: 'aceite',
      status: r.status,
      candidatoId: id,
      contractUrl,
      data: r.data,
      raw: r.raw,
    }
  }
  return { ok: false, error: `step inválido: ${step}` }
}

export async function runCaptacaoTestPipeline(env, body = {}) {
  const leadId = Number(body.leadId ?? body.id_lead)
  const telefone = body.telefone || body.phone
  if (!telefone) return { ok: false, error: 'telefone obrigatório' }
  if (!Number.isFinite(leadId) || leadId <= 0) {
    return { ok: false, error: 'leadId obrigatório (Kommo)' }
  }
  if (!isSumareCaptacaoEnabled(env)) {
    return { ok: false, code: 'CAPTACAO_DISABLED' }
  }

  const sendWhatsapp = body.sendWhatsapp !== false
  if (!sendWhatsapp) {
    const prev = await runCaptacaoTestWorkflow(env, { ...body, dryRun: false, sendWhatsapp: false })
    return { ...prev, pipeline: 'api_only_no_whatsapp' }
  }

  const out = await runMatriculaCaptacaoAfterForm(env, {
    telefone,
    leadId,
    pushName: body.pushName,
    executionId: body.executionId || `test-cap-${Date.now()}`,
  })
  return { ok: out.ok, pipeline: true, ...out }
}
