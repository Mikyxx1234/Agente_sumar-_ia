/**
 * API Captação Sumaré — espelha o fluxo n8n:
 *   gerar candidato → status → aceite contrato → link portal
 *
 * Env:
 *   SUMARE_CAPTACAO_ENABLED=true
 *   SUMARE_CAPTACAO_BASE_URL=https://api-captacao.sumare.edu.br
 *   SUMARE_CAPTACAO_TOKEN=Bearer ...
 *   SUMARE_CONTRATO_PORTAL_URL=https://sumare.edu.br/vem-pra-sumare/vestibular/contrato
 */

import { getDefaultTipoIngresso } from './inscricaoConfig.js'
import { matchPoloFromUserMessage, resolvePoloUnidadeCode } from '../libShared/sumarePoloCatalog.js'
import { resolveCursoCodigoFromDb } from './sumareCaptacaoCursoStore.js'
import {
  parseGerarCandidatoPayload,
  classifyGerarCandidatoOutcome,
} from '../libShared/captacaoGerarOutcome.js'

export { parseGerarCandidatoPayload, classifyGerarCandidatoOutcome } from '../libShared/captacaoGerarOutcome.js'

export function isSumareCaptacaoEnabled(env = process.env) {
  if (String(env.SUMARE_CAPTACAO_ENABLED || '').trim().toLowerCase() === 'false') {
    return false
  }
  const token = env.SUMARE_CAPTACAO_TOKEN || env.SUMARE_CAPTACAO_BEARER || ''
  return Boolean(String(env.SUMARE_CAPTACAO_BASE_URL || '').trim() && token.trim())
}

function getConfig(env) {
  return {
    base: (env.SUMARE_CAPTACAO_BASE_URL || 'https://api-captacao.sumare.edu.br').replace(/\/+$/, ''),
    token: String(env.SUMARE_CAPTACAO_TOKEN || env.SUMARE_CAPTACAO_BEARER || '').trim(),
    portalBase: (
      env.SUMARE_CONTRATO_PORTAL_URL ||
      'https://sumare.edu.br/vem-pra-sumare/vestibular/contrato'
    ).replace(/\/+$/, ''),
  }
}

function authHeader(token) {
  const t = token.replace(/^Bearer\s+/i, '').trim()
  return `Bearer ${t}`
}

async function captacaoFetch(env, pathWithQuery, { method = 'GET', timeoutMs = 45_000 } = {}) {
  const { base, token } = getConfig(env)
  if (!token) {
    return { ok: false, code: 'CAPTACAO_NOT_CONFIGURED', error: 'SUMARE_CAPTACAO_TOKEN ausente' }
  }
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`
  const url = `${base}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: authHeader(token),
      },
      signal: controller.signal,
    })
    const raw = await res.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = raw
    }
    return {
      ok: res.ok,
      status: res.status,
      data,
      raw: typeof raw === 'string' ? raw.slice(0, 800) : '',
    }
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'timeout' : e.message
    return { ok: false, code: 'CAPTACAO_FETCH_FAILED', error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/** Dígitos do CPF (11) ou vazio. */
export function normalizeCpf(input) {
  const d = String(input || '').replace(/\D/g, '')
  return d.length === 11 ? d : d.length >= 11 ? d.slice(0, 11) : ''
}

/** Formato exibido na API: (11) 94501-0493 */
export function formatCelularBrasil(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (d.length < 10) return ''
  const withCountry = d.length >= 12 && d.startsWith('55') ? d.slice(2) : d
  const ddd = withCountry.slice(0, 2)
  const rest = withCountry.slice(2)
  if (rest.length === 9) return `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`
  if (rest.length === 8) return `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`
  return `(${ddd}) ${rest}`
}

function normalizeCursoNomeKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function parseCursoMapEnv(env) {
  const raw = String(env.SUMARE_CAPTACAO_CURSO_MAP || '').trim()
  if (!raw) return null
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    const map = new Map()
    for (const [k, v] of Object.entries(obj)) {
      const code = String(v || '').trim().toUpperCase()
      if (code) map.set(normalizeCursoNomeKey(k), code)
    }
    return map.size ? map : null
  } catch {
    return null
  }
}

/** Nomes exibidos (sum_Curso) → código API Captação. Override via SUMARE_CAPTACAO_CURSO_MAP (JSON). */
const CURSO_NOME_TO_CODIGO = new Map(
  Object.entries({
    'administracao': 'ADM_EAD',
    'analise e desenvolvimento de sistemas': 'ADS_EAD',
    'ciencia da computacao': 'CCOMP_EAD',
    'ciencias contabeis': 'CCONT_EAD',
    'ciencias economicas': 'CECON_EAD',
    'engenharia civil': 'ECIV_EAD',
    'engenharia de producao': 'ENGP_EAD',
    'engenharia producao': 'ENGP_EAD',
    'fisioterapia': 'FISIO_EAD',
    'gestao financeira': 'GFIN_EAD',
    'historia': 'HIST_EAD',
    'jogos digitais': 'JOGOS_EAD',
    'marketing': 'MKT_EAD',
    'pedagogia': 'PED_EAD',
    'psicologia': 'PSI_EAD',
    'economia': 'ECON_EAD',
  }),
)

/** Código curso API (ex. ECON_EAD) — aceita valor já codificado, mapa por nome ou default env. */
export function resolveCursoCodigo(cursoInscricao, env = process.env) {
  const raw = String(cursoInscricao || '').trim()
  if (/^[A-Z0-9_]{4,32}$/i.test(raw)) return raw.toUpperCase()
  const key = normalizeCursoNomeKey(raw)
  const fromEnv = parseCursoMapEnv(env)
  if (fromEnv?.has(key)) return fromEnv.get(key)
  if (CURSO_NOME_TO_CODIGO.has(key)) return CURSO_NOME_TO_CODIGO.get(key)
  const def = String(env.SUMARE_CAPTACAO_CURSO_DEFAULT || '').trim()
  return def ? def.toUpperCase() : ''
}

/** Parâmetros que a API exige na query mesmo vazios (espelha workflow n8n). */
export const GERAR_CANDIDATO_QUERY_DEFAULTS = {
  utmSource: '',
  utmCampaign: '',
  utmMedium: '',
  planoPgto: '',
  quemIndicou: '',
  localInscricao: '',
  dispositivo: '',
  raAntigo: '',
  cursoAntigo: '',
  instituicaoAntiga: '',
}

export function normalizeDataNasc(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (br) return `${br[3]}-${br[2]}-${br[1]}`
  return ''
}

export function normalizeSexo(input) {
  const s = String(input || '').trim().toUpperCase()
  if (s.startsWith('M')) return 'M'
  if (s.startsWith('F')) return 'F'
  return ''
}

/**
 * Extrai id do candidato da resposta da API (vários formatos possíveis).
 */
export function extractCandidatoId(payload) {
  if (payload == null) return null
  if (typeof payload === 'string' || typeof payload === 'number') {
    const s = String(payload).trim()
    return s.length >= 8 ? s : null
  }
  const candidates = [
    payload.candidato,
    payload.candidatoId,
    payload.candidato_id,
    payload.id,
    payload.idCandidato,
    payload?.data?.candidato,
    payload?.data?.id,
    payload?.result?.candidato,
  ]
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim()
  }
  return null
}

/** URL do portal (tela Termos de Contrato + ASSINAR CONTRATO). */
export function buildContratoPortalUrl(env, candidatoId) {
  const id = String(candidatoId || '').trim()
  if (!id) return ''
  const base = getConfig(env).portalBase
  return `${base}?id=${encodeURIComponent(id)}`
}

/** URL do portal na etapa de pagamento (meioPagamento). */
export function buildMeioPagamentoPortalUrl(env, candidatoId) {
  const id = String(candidatoId || '').trim()
  if (!id) return ''
  const contratoBase = getConfig(env).portalBase.replace(/\/+$/, '')
  const vestibularBase = contratoBase.replace(/\/contrato\/?$/i, '')
  return `${vestibularBase}/meioPagamento?id=${encodeURIComponent(id)}`
}

export function extractCandidatoStatusString(statusPayload) {
  if (!statusPayload || typeof statusPayload !== 'object') return null
  const raw = statusPayload.status ?? statusPayload.candidato?.status ?? null
  const s = raw != null ? String(raw).trim() : ''
  return s || null
}

/** Candidato já passou da etapa de aceite no portal (API status). */
export function statusImpliesPagamentoPhase(statusStr) {
  const s = String(statusStr || '').toLowerCase()
  if (!s) return false
  return s.includes('meiopagamento') || s === 'pagamento' || s.includes('pagamento')
}

/**
 * Escolhe URL do portal conforme status do candidato na API Sumaré.
 * @returns {{ url: string, phase: 'contrato'|'pagamento' }}
 */
export function resolvePortalUrlForCandidato(env, candidatoId, statusStr) {
  const id = String(candidatoId || '').trim()
  if (!id) return { url: '', phase: 'contrato' }
  if (statusImpliesPagamentoPhase(statusStr)) {
    return { url: buildMeioPagamentoPortalUrl(env, id), phase: 'pagamento' }
  }
  return { url: buildContratoPortalUrl(env, id), phase: 'contrato' }
}

function extractUrlFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const urls = [
    payload.url,
    payload.link,
    payload.linkAceite,
    payload.link_aceite,
    payload.linkContrato,
    payload?.data?.url,
    payload?.data?.link,
  ]
  for (const u of urls) {
    const s = String(u || '').trim()
    if (/^https?:\/\//i.test(s)) return s
  }
  return ''
}

/**
 * Monta query string do GET /api-ingresso/candidato/gerar
 */
export function buildGerarCandidatoQuery(snapshot, telefone, env = process.env) {
  const fone = formatCelularBrasil(telefone)
  const cpf = normalizeCpf(snapshot?.cpf)
  const curso = resolveCursoCodigo(snapshot?.curso_inscricao, env)
  let unidade = String(snapshot?.unidade || '').trim().toUpperCase()
  if (!/^ED_SP_/i.test(unidade) && snapshot?.polo_inscricao) {
    const matched = matchPoloFromUserMessage(snapshot.polo_inscricao)
    if (matched) unidade = resolvePoloUnidadeCode(matched.id, env)
  }
  if (!unidade) {
    unidade = String(env.SUMARE_CAPTACAO_UNIDADE_DEFAULT || 'ED_SP_P5').trim()
  }
  const turno = String(snapshot?.turno || env.SUMARE_CAPTACAO_TURNO_DEFAULT || 'EAD').trim()
  const dataNasc =
    normalizeDataNasc(snapshot?.data_nasc) ||
    String(env.SUMARE_CAPTACAO_DATA_NASC_DEFAULT || '').trim()
  const sexo =
    normalizeSexo(snapshot?.sexo) || String(env.SUMARE_CAPTACAO_SEXO_DEFAULT || 'M').trim()
  const tipoIngresso = String(
    snapshot?.tipo_inscricao || getDefaultTipoIngresso(env),
  ).trim()

  return {
    ...GERAR_CANDIDATO_QUERY_DEFAULTS,
    cpf,
    celular: fone,
    nomeCompl: String(snapshot?.nome || '').trim(),
    email: String(snapshot?.email || '').trim(),
    dataNasc,
    sexo,
    curso,
    turno,
    unidade,
    tipoIngresso,
    sumareComVc: 'N',
  }
}

/** Igual a buildGerarCandidatoQuery, mas consulta sumare_captacao_curso no Supabase se curso vazio. */
export async function buildGerarCandidatoQueryAsync(snapshot, telefone, env = process.env) {
  const params = buildGerarCandidatoQuery(snapshot, telefone, env)
  if (params.curso) return params
  const fromDb = await resolveCursoCodigoFromDb(snapshot?.curso_inscricao, env)
  if (fromDb) return { ...params, curso: fromDb }
  return params
}

export function validateGerarCandidatoParams(params) {
  const missing = []
  if (!params.cpf) missing.push('cpf')
  if (!params.celular) missing.push('celular')
  if (!params.nomeCompl) missing.push('nome')
  if (!params.email) missing.push('email')
  if (!params.curso) missing.push('curso')
  if (!params.unidade) missing.push('unidade')
  if (!params.dataNasc) missing.push('dataNasc')
  if (!params.sexo) missing.push('sexo')
  return missing
}

/**
 * GET /api-ingresso/candidato/gerar?...
 */
export async function gerarCandidatoIngresso(env, params) {
  const merged = { ...GERAR_CANDIDATO_QUERY_DEFAULTS, ...params }
  const qs = new URLSearchParams()
  for (const [key, val] of Object.entries(merged)) {
    if (val == null) continue
    qs.set(key, String(val).trim())
  }
  return captacaoFetch(env, `/api-ingresso/candidato/gerar?${qs.toString()}`)
}

/**
 * GET /api-status-candidato/candidato/status?candidato=
 */
export async function consultarStatusCandidato(env, candidatoId) {
  const id = encodeURIComponent(String(candidatoId))
  return captacaoFetch(env, `/api-status-candidato/candidato/status?candidato=${id}`)
}

/**
 * GET /api-contrato-ingresso/contrato/ingresso/aceite?candidato=
 */
export async function solicitarAceiteContrato(env, candidatoId) {
  const id = encodeURIComponent(String(candidatoId))
  return captacaoFetch(env, `/api-contrato-ingresso/contrato/ingresso/aceite?candidato=${id}`)
}

/**
 * Fluxo completo: gerar → status → aceite → URL do portal.
 */
export async function runCaptacaoContratoWorkflow(env, { snapshot, telefone, captacaoContext = {} }) {
  const steps = []
  const params = await buildGerarCandidatoQueryAsync(snapshot, telefone, env)
  const missing = validateGerarCandidatoParams(params)
  const requestedCurso = {
    nome: String(snapshot?.curso_inscricao || '').trim(),
    codigo: params.curso,
  }
  if (missing.length) {
    return {
      ok: false,
      code: 'MISSING_FIELDS',
      missing,
      steps,
      error: `Dados insuficientes para inscrição Sumaré: ${missing.join(', ')}`,
    }
  }

  const priorCandidatoId = String(captacaoContext.priorCandidatoId || '').trim()
  const priorCursoCodigo = String(captacaoContext.priorCursoCodigo || '').trim().toUpperCase()
  const confirmedNovaInscricao = Boolean(captacaoContext.confirmedNovaInscricao)
  const useCandidatoId = String(captacaoContext.useCandidatoId || '').trim()

  if (
    priorCandidatoId &&
    priorCursoCodigo &&
    params.curso &&
    priorCursoCodigo !== params.curso.toUpperCase() &&
    !confirmedNovaInscricao &&
    !useCandidatoId
  ) {
    return {
      ok: false,
      code: 'NEEDS_CONFIRM_NOVA_INSCRICAO',
      steps,
      priorCandidatoId,
      priorCursoCodigo,
      priorCursoNome: captacaoContext.priorCursoNome || null,
      requestedCurso,
      error: 'Candidato já possui inscrição em outro curso — confirmação necessária',
    }
  }

  let candidatoId = useCandidatoId || null
  let gerar = { ok: true, data: null, status: null, skipped: Boolean(useCandidatoId) }

  if (!candidatoId) {
    gerar = await gerarCandidatoIngresso(env, params)
    steps.push({ step: 'gerar_candidato', ok: gerar.ok, status: gerar.status })
    if (!gerar.ok) {
      return {
        ok: false,
        code: 'GERAR_FAILED',
        steps,
        error: gerar.error || gerar.raw || `HTTP ${gerar.status}`,
        priorCandidatoId: priorCandidatoId || null,
        requestedCurso,
      }
    }

    candidatoId = extractCandidatoId(gerar.data)
    if (!candidatoId && typeof gerar.data === 'string') {
      candidatoId = extractCandidatoId(gerar.data.trim())
    }
  } else {
    steps.push({ step: 'gerar_candidato', ok: true, skipped: true, candidatoId })
  }

  if (!candidatoId) {
    return {
      ok: false,
      code: 'CANDIDATO_ID_MISSING',
      steps,
      error: 'API gerar candidato não retornou id do candidato',
      raw: gerar.raw,
    }
  }

  const gerarParsed = parseGerarCandidatoPayload(gerar.data)
  const gerarOutcome = classifyGerarCandidatoOutcome(gerarParsed, requestedCurso)
  steps.push({
    step: 'gerar_outcome',
    kind: gerarOutcome.kind,
    pagina: gerarParsed?.pagina,
    sameCourse: gerarOutcome.sameCourse,
    cursoApi: gerarParsed?.cursoCodigo,
  })

  if (gerarOutcome.kind === 'multiple_inscricoes_portal') {
    return {
      ok: false,
      code: 'MULTIPLE_INSCRICOES_PORTAL',
      steps,
      candidatoId,
      gerarOutcome,
      requestedCurso,
      portalCandidatoUrl: buildPortalCandidatoSelecaoUrl(env),
      error: 'Várias inscrições existentes — confirmação no portal',
    }
  }

  if (
    gerarOutcome.kind === 'different_course_new' &&
    priorCandidatoId &&
    priorCandidatoId !== candidatoId &&
    !confirmedNovaInscricao
  ) {
    return {
      ok: false,
      code: 'NEEDS_CONFIRM_NOVA_INSCRICAO',
      steps,
      candidatoId,
      priorCandidatoId,
      priorCursoCodigo,
      priorCursoNome: captacaoContext.priorCursoNome || null,
      requestedCurso,
      gerarOutcome,
      error: 'Nova inscrição criada em curso diferente — aguardando confirmação do lead',
    }
  }

  const statusAfterGerar = await consultarStatusCandidato(env, candidatoId)
  const statusStrGerar = extractCandidatoStatusString(statusAfterGerar.data)
  steps.push({
    step: 'status_candidato',
    ok: statusAfterGerar.ok,
    status: statusAfterGerar.status,
    candidatoId,
    apiStatus: statusStrGerar,
  })

  const sameCourseInProgress = gerarOutcome.kind === 'same_course_in_progress'

  let aceite = { ok: true, skipped: true, data: null, status: null }
  if (!statusImpliesPagamentoPhase(statusStrGerar) && !sameCourseInProgress) {
    aceite = await solicitarAceiteContrato(env, candidatoId)
    steps.push({ step: 'aceite_contrato', ok: aceite.ok, status: aceite.status })
  } else {
    steps.push({
      step: 'aceite_contrato',
      ok: true,
      skipped: true,
      reason: sameCourseInProgress
        ? 'same_course_already_in_payment'
        : 'already_meio_pagamento_after_gerar',
    })
  }

  const statusFinal = await consultarStatusCandidato(env, candidatoId)
  const statusStrFinal =
    extractCandidatoStatusString(statusFinal.data) || statusStrGerar || null
  steps.push({
    step: 'status_pos_aceite',
    ok: statusFinal.ok,
    apiStatus: statusStrFinal,
  })

  const portalResolved = resolvePortalUrlForCandidato(env, candidatoId, statusStrFinal)
  let contractUrl = extractUrlFromPayload(aceite.data)
  if (!contractUrl || !/^https?:\/\//i.test(contractUrl)) {
    contractUrl = portalResolved.url
  } else if (portalResolved.phase === 'pagamento' && !/meiopagamento/i.test(contractUrl)) {
    contractUrl = portalResolved.url
  }

  if (!aceite.ok && !aceite.skipped) {
    console.warn(
      `[sumareCaptacao] aceite HTTP ${aceite.status} — usando link portal fallback candidato=${candidatoId} phase=${portalResolved.phase}`,
    )
  }

  return {
    ok: true,
    candidatoId,
    contractUrl,
    portalPhase: portalResolved.phase,
    candidatoStatus: statusStrFinal,
    gerarOutcome,
    sameCourseInProgress,
    requestedCurso,
    cursoCodigo: gerarParsed?.cursoCodigo || params.curso,
    cursoNome: gerarParsed?.nomeCurso || requestedCurso.nome,
    steps,
    gerar: gerar.data,
    status: statusFinal.data,
    aceite: aceite.data,
  }
}

/** URL do portal quando há várias inscrições (tela "Gostaria de continuar?"). */
export function buildPortalCandidatoSelecaoUrl(env) {
  const contratoBase = getConfig(env).portalBase.replace(/\/+$/, '')
  const vestibularBase = contratoBase.replace(/\/contrato\/?$/i, '')
  return `${vestibularBase.replace(/\/vestibular\/?$/i, '')}/candidato`
}
