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

/** Código curso API (ex. ECON_EAD) — aceita valor já codificado ou default env. */
export function resolveCursoCodigo(cursoInscricao, env = process.env) {
  const raw = String(cursoInscricao || '').trim()
  if (/^[A-Z0-9_]{4,32}$/i.test(raw)) return raw.toUpperCase()
  const def = String(env.SUMARE_CAPTACAO_CURSO_DEFAULT || '').trim()
  return def ? def.toUpperCase() : ''
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
  const unidade =
    String(snapshot?.unidade || snapshot?.polo_inscricao || env.SUMARE_CAPTACAO_UNIDADE_DEFAULT || 'ED_SP_P5').trim()
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
  const qs = new URLSearchParams()
  for (const [key, val] of Object.entries(params)) {
    if (val != null && String(val).trim() !== '') qs.set(key, String(val).trim())
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
export async function runCaptacaoContratoWorkflow(env, { snapshot, telefone }) {
  const steps = []
  const params = buildGerarCandidatoQuery(snapshot, telefone, env)
  const missing = validateGerarCandidatoParams(params)
  if (missing.length) {
    return {
      ok: false,
      code: 'MISSING_FIELDS',
      missing,
      steps,
      error: `Dados insuficientes para inscrição Sumaré: ${missing.join(', ')}`,
    }
  }

  const gerar = await gerarCandidatoIngresso(env, params)
  steps.push({ step: 'gerar_candidato', ok: gerar.ok, status: gerar.status })
  if (!gerar.ok) {
    return {
      ok: false,
      code: 'GERAR_FAILED',
      steps,
      error: gerar.error || gerar.raw || `HTTP ${gerar.status}`,
    }
  }

  let candidatoId = extractCandidatoId(gerar.data)
  if (!candidatoId && typeof gerar.data === 'string') {
    candidatoId = extractCandidatoId(gerar.data.trim())
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

  const status = await consultarStatusCandidato(env, candidatoId)
  steps.push({ step: 'status_candidato', ok: status.ok, status: status.status, candidatoId })

  const aceite = await solicitarAceiteContrato(env, candidatoId)
  steps.push({ step: 'aceite_contrato', ok: aceite.ok, status: aceite.status })

  let contractUrl = extractUrlFromPayload(aceite.data)
  if (!contractUrl) contractUrl = buildContratoPortalUrl(env, candidatoId)

  if (!aceite.ok) {
    console.warn(
      `[sumareCaptacao] aceite HTTP ${aceite.status} — usando link portal fallback candidato=${candidatoId}`,
    )
  }

  return {
    ok: true,
    candidatoId,
    contractUrl,
    steps,
    gerar: gerar.data,
    status: status.data,
    aceite: aceite.data,
  }
}
