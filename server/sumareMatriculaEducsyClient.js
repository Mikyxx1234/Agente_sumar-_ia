/**
 * Inscrição no portal novo (HAR matricula.sumare.edu.br):
 *   Softsy login → oferta → pessoa-candidato → api-inscricao-educsy → assinar → link /Vestibular/pagamento?cpf=
 *
 * Env:
 *   SUMARE_SOFTSY_BASE_URL=https://gateway-sumare.softsy.io
 *   SUMARE_SOFTSY_LOGIN=
 *   SUMARE_SOFTSY_PASSWORD=
 *   SUMARE_MATRICULA_PORTAL_URL=https://matricula.sumare.edu.br
 *   SUMARE_MATRICULA_UTM_CAMPAIGN=sumareeadpolos
 */

const DEFAULT_SOFTSY_BASE = 'https://gateway-sumare.softsy.io'
const DEFAULT_PORTAL = 'https://matricula.sumare.edu.br'
const DEFAULT_UTM = 'sumareeadpolos'
const DEFAULT_CONTA_ID = 1
const DEFAULT_TIPO_INGRESSO_ID = 17
const TOKEN_SKEW_MS = 15_000

let _tokenCache = { token: '', expAt: 0 }

function normalizeCpf(input) {
  const d = String(input || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.length < 11) return d.padStart(11, '0')
  return d.slice(0, 11)
}

export function isSumareEducsyEnabled(env = process.env) {
  const login = String(env.SUMARE_SOFTSY_LOGIN || '').trim()
  const password = String(env.SUMARE_SOFTSY_PASSWORD || env.SUMARE_SOFTSY_SENHA || '').trim()
  return Boolean(login && password)
}

export function shouldUseEducsyInscricao(env = process.env, snapshot = null) {
  const path = String(env.SUMARE_INSCRICAO_PATH || 'educsy').trim().toLowerCase()
  if (path === 'legacy' || path === 'captacao' || path === 'gerar') return false
  if (snapshot && /transfer/i.test(String(snapshot.tipo_inscricao || ''))) return false
  if (snapshot && String(snapshot.transferencia_curso_origem || '').trim()) return false
  return isSumareEducsyEnabled(env)
}

export function getMatriculaPortalBase(env = process.env) {
  return String(env.SUMARE_MATRICULA_PORTAL_URL || DEFAULT_PORTAL).replace(/\/+$/, '')
}

export function getMatriculaUtmCampaign(env = process.env) {
  return String(env.SUMARE_MATRICULA_UTM_CAMPAIGN || DEFAULT_UTM).trim() || DEFAULT_UTM
}

/** Portal novo identifica o candidato pelo CPF, não pelo código 2026… */
export function buildMatriculaPagamentoUrl(env, { cpf } = {}) {
  const digits = normalizeCpf(cpf)
  if (!digits) return ''
  const qs = new URLSearchParams({
    cpf: digits,
    utm_campaign: getMatriculaUtmCampaign(env),
  })
  return `${getMatriculaPortalBase(env)}/Vestibular/pagamento?${qs.toString()}`
}

export function buildMatriculaTermoContratoUrl(env, { cpf } = {}) {
  const digits = normalizeCpf(cpf)
  if (!digits) return ''
  const qs = new URLSearchParams({
    cpf: digits,
    utm_campaign: getMatriculaUtmCampaign(env),
  })
  return `${getMatriculaPortalBase(env)}/Vestibular/termo-contrato?${qs.toString()}`
}

/** SEMIPRESENCIAL (API antiga) → SEMI (Softsy / educsy). */
export function normalizeEducsyTurno(turno) {
  const t = String(turno || '').trim().toUpperCase()
  if (!t) return ''
  if (t.includes('SEMI')) return 'SEMI'
  if (t === 'EAD' || t.includes('DISTAN')) return 'EAD'
  return t
}

export function normalizeEducsyCelular(telefone) {
  let d = String(telefone || '').replace(/\D/g, '')
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2)
  if (d.length < 10) return ''
  return d.slice(0, 11)
}

function softsyConfig(env) {
  return {
    base: String(env.SUMARE_SOFTSY_BASE_URL || DEFAULT_SOFTSY_BASE).replace(/\/+$/, ''),
    login: String(env.SUMARE_SOFTSY_LOGIN || '').trim(),
    password: String(env.SUMARE_SOFTSY_PASSWORD || env.SUMARE_SOFTSY_SENHA || '').trim(),
    contaId: Number(env.SUMARE_SOFTSY_CONTA_ID || DEFAULT_CONTA_ID) || DEFAULT_CONTA_ID,
    tipoIngressoId:
      Number(env.SUMARE_SOFTSY_TIPO_INGRESSO_ID || DEFAULT_TIPO_INGRESSO_ID) ||
      DEFAULT_TIPO_INGRESSO_ID,
    utm: getMatriculaUtmCampaign(env),
  }
}

function browserHeaders(extra = {}) {
  return {
    Accept: 'application/json',
    Origin: 'https://matricula.sumare.edu.br',
    Referer: 'https://matricula.sumare.edu.br/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    ...extra,
  }
}

async function readJsonRes(res) {
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
}

export async function softsyLogin(env = process.env) {
  const { base, login, password } = softsyConfig(env)
  if (!login || !password) {
    return { ok: false, code: 'SOFTSY_NOT_CONFIGURED', error: 'SUMARE_SOFTSY_LOGIN/PASSWORD ausentes' }
  }
  const now = Date.now()
  if (_tokenCache.token && _tokenCache.expAt > now + TOKEN_SKEW_MS) {
    return { ok: true, token: _tokenCache.token, cached: true }
  }
  try {
    const res = await fetch(`${base}/auth/v1/login`, {
      method: 'POST',
      headers: browserHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ login, senha: password }),
    })
    const parsed = await readJsonRes(res)
    const token = parsed.data?.accessToken || parsed.data?.token || ''
    if (!parsed.ok || !token) {
      return {
        ok: false,
        code: 'SOFTSY_LOGIN_FAILED',
        status: parsed.status,
        error: parsed.raw || `HTTP ${parsed.status}`,
      }
    }
    const expiresIn = Number(parsed.data?.expiresIn || 300)
    _tokenCache = { token, expAt: now + Math.max(30, expiresIn) * 1000 }
    return { ok: true, token, cached: false }
  } catch (e) {
    return { ok: false, code: 'SOFTSY_LOGIN_FAILED', error: e.message }
  }
}

async function softsyFetch(env, pathWithQuery, { method = 'GET', body = null, token } = {}) {
  const { base } = softsyConfig(env)
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`
  const headers = browserHeaders({
    Authorization: `Bearer ${token}`,
    idconta: String(softsyConfig(env).contaId),
  })
  if (body != null) headers['Content-Type'] = 'application/json'
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    })
    return readJsonRes(res)
  } catch (e) {
    return { ok: false, code: 'SOFTSY_FETCH_FAILED', error: e.message }
  }
}

function pickCurso(cursos, codigo) {
  const want = String(codigo || '').trim().toUpperCase()
  if (!want || !Array.isArray(cursos)) return null
  return (
    cursos.find((c) => String(c.codigoCurso || '').toUpperCase() === want) ||
    cursos.find((c) => String(c.codCursoInep || '').toUpperCase() === want) ||
    null
  )
}

function pickEscola(escolas, unidade) {
  const want = String(unidade || '').trim().toUpperCase()
  if (!want || !Array.isArray(escolas)) return null
  return (
    escolas.find((e) => String(e.codEscola || '').toUpperCase() === want) ||
    escolas.find((e) => String(e.codigoInep || '').toUpperCase() === want) ||
    null
  )
}

export async function resolveOfertaEducsy(env, { cursoCodigo, unidade, turno }, token) {
  const cfg = softsyConfig(env)
  const educsyTurno = normalizeEducsyTurno(turno)
  const turnosRes = await softsyFetch(
    env,
    `/oferta-concurso/v1/turnos-concurso?idConta=${cfg.contaId}&idTipoIngresso=${cfg.tipoIngressoId}&codigoUtm=${encodeURIComponent(cfg.utm)}`,
    { token },
  )
  if (!turnosRes.ok) {
    return { ok: false, code: 'SOFTSY_TURNOS_FAILED', error: turnosRes.raw || `HTTP ${turnosRes.status}` }
  }
  const turnos = Array.isArray(turnosRes.data) ? turnosRes.data : []
  const turnoRow =
    turnos.find((t) => String(t.mnemonico || '').toUpperCase() === educsyTurno) ||
    turnos.find((t) => normalizeEducsyTurno(t.turno) === educsyTurno) ||
    null
  if (!turnoRow?.idTurno) {
    return { ok: false, code: 'SOFTSY_TURNO_NOT_FOUND', error: `Turno ${educsyTurno} não encontrado na oferta` }
  }

  const cursosRes = await softsyFetch(
    env,
    `/oferta-concurso/v1/cursos-concurso?idConta=${cfg.contaId}&idTurno=${turnoRow.idTurno}&idTipoIngresso=${cfg.tipoIngressoId}&codigoUtm=${encodeURIComponent(cfg.utm)}`,
    { token },
  )
  if (!cursosRes.ok) {
    return { ok: false, code: 'SOFTSY_CURSOS_FAILED', error: cursosRes.raw || `HTTP ${cursosRes.status}` }
  }
  const cursoRow = pickCurso(cursosRes.data, cursoCodigo)
  if (!cursoRow?.idCurso) {
    return { ok: false, code: 'SOFTSY_CURSO_NOT_FOUND', error: `Curso ${cursoCodigo} não encontrado na oferta` }
  }

  const escolasRes = await softsyFetch(
    env,
    `/oferta-concurso/v1/escolas-concurso?idConta=${cfg.contaId}&idTurno=${turnoRow.idTurno}&idCurso=${cursoRow.idCurso}&idTipoIngresso=${cfg.tipoIngressoId}&codigoUtm=${encodeURIComponent(cfg.utm)}`,
    { token },
  )
  if (!escolasRes.ok) {
    return { ok: false, code: 'SOFTSY_POLOS_FAILED', error: escolasRes.raw || `HTTP ${escolasRes.status}` }
  }
  const escolaRow = pickEscola(escolasRes.data, unidade)
  if (!escolaRow?.idEscola) {
    return { ok: false, code: 'SOFTSY_POLO_NOT_FOUND', error: `Unidade ${unidade} não encontrada na oferta` }
  }

  const valorRes = await softsyFetch(
    env,
    `/oferta-concurso/v1/infoValor?idCurso=${cursoRow.idCurso}&idEscola=${escolaRow.idEscola}&idTurno=${turnoRow.idTurno}&codigoUtm=${encodeURIComponent(cfg.utm)}`,
    { token },
  )
  if (!valorRes.ok || !valorRes.data?.idOfertaConcurso) {
    return { ok: false, code: 'SOFTSY_VALOR_FAILED', error: valorRes.raw || `HTTP ${valorRes.status}` }
  }

  return {
    ok: true,
    oferta: {
      idTurno: turnoRow.idTurno,
      idCurso: cursoRow.idCurso,
      idEscola: escolaRow.idEscola,
      idTipoIngresso: cfg.tipoIngressoId,
      idOfertaConcurso: valorRes.data.idOfertaConcurso,
      concurso: valorRes.data.concurso,
      utm: cfg.utm,
      contaId: cfg.contaId,
      cursoCodigo: cursoRow.codigoCurso || cursoCodigo,
      cursoNome: cursoRow.nome || '',
      unidade: escolaRow.codEscola || unidade,
      turno: educsyTurno,
    },
  }
}

async function criarPessoaCandidato(env, { oferta, pessoa, token }) {
  const qs = new URLSearchParams({
    idCurso: String(oferta.idCurso),
    idEscola: String(oferta.idEscola),
    idTurno: String(oferta.idTurno),
    idTipoIngresso: String(oferta.idTipoIngresso),
    utmNome: oferta.utm,
    idOfertaConcurso: String(oferta.idOfertaConcurso),
  })
  const body = {
    pessoaDTO: {
      contaId: oferta.contaId,
      nomeCompleto: pessoa.nomeCompleto,
      sexo: pessoa.sexo,
      dtNascimento: pessoa.dtNascimento,
      cpf: pessoa.cpf,
      email: pessoa.email,
      celular: pessoa.celular,
    },
    candidatoDTO: {
      contaId: oferta.contaId,
      tipoIngressoId: oferta.idTipoIngresso,
    },
  }
  const created = await softsyFetch(env, `/candidato/v1/pessoa-candidato?${qs.toString()}`, {
    method: 'POST',
    body,
    token,
  })
  if (created.ok && (created.data?.candidato || created.data?.idCandidato)) {
    return {
      ok: true,
      candidato: String(created.data.candidato || ''),
      idCandidato: created.data.idCandidato,
    }
  }

  const existing = await softsyFetch(env, `/candidato/v1/cpf/${pessoa.cpf}`, { token })
  const row = Array.isArray(existing.data?.data) ? existing.data.data[0] : existing.data
  const candidato = row?.candidato || row?.codigoCandidato || existing.data?.candidato
  const idCandidato = row?.idCandidato || existing.data?.idCandidato
  if (candidato || idCandidato) {
    return { ok: true, candidato: String(candidato || ''), idCandidato, reused: true }
  }
  return {
    ok: false,
    code: 'SOFTSY_PESSOA_CANDIDATO_FAILED',
    status: created.status,
    error: created.raw || `HTTP ${created.status}`,
  }
}

async function registrarInscricaoEducsy(env, payload) {
  const captacaoBase = String(env.SUMARE_CAPTACAO_BASE_URL || 'https://api-captacao.sumare.edu.br').replace(
    /\/+$/,
    '',
  )
  const headers = browserHeaders({ 'Content-Type': 'application/json' })
  const token = String(env.SUMARE_CAPTACAO_TOKEN || env.SUMARE_CAPTACAO_BEARER || '').trim()
  if (token) headers.Authorization = token.replace(/^Bearer\s+/i, '') ? `Bearer ${token.replace(/^Bearer\s+/i, '')}` : token
  try {
    const res = await fetch(`${captacaoBase}/api-inscricao-educsy/inscricao`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    return readJsonRes(res)
  } catch (e) {
    return { ok: false, code: 'EDUCSY_INSCRICAO_FAILED', error: e.message }
  }
}

/**
 * Fluxo HAR completo. `params` no formato de buildGerarCandidatoQuery
 * (curso, unidade, turno, cpf, email, nomeCompl, dataNasc, sexo).
 */
export async function runEducsyInscricaoWorkflow(env, { snapshot, params, telefone }) {
  const steps = []
  const login = await softsyLogin(env)
  steps.push({ step: 'softsy_login', ok: login.ok })
  if (!login.ok) {
    return { ok: false, code: login.code || 'SOFTSY_LOGIN_FAILED', error: login.error, steps }
  }

  const ofertaRes = await resolveOfertaEducsy(
    env,
    { cursoCodigo: params.curso, unidade: params.unidade, turno: params.turno },
    login.token,
  )
  steps.push({
    step: 'resolver_oferta',
    ok: ofertaRes.ok,
    idCurso: ofertaRes.oferta?.idCurso,
    idEscola: ofertaRes.oferta?.idEscola,
    idOfertaConcurso: ofertaRes.oferta?.idOfertaConcurso,
  })
  if (!ofertaRes.ok) {
    return { ok: false, code: ofertaRes.code, error: ofertaRes.error, steps }
  }

  const pessoa = {
    nomeCompleto: String(params.nomeCompl || snapshot?.nome || '').trim(),
    sexo: String(params.sexo || 'F').trim().toUpperCase().slice(0, 1),
    dtNascimento: String(params.dataNasc || '').trim(),
    cpf: normalizeCpf(params.cpf || snapshot?.cpf),
    email: String(params.email || snapshot?.email || '').trim(),
    celular: normalizeEducsyCelular(params.celular || telefone),
  }
  if (!pessoa.cpf || !pessoa.email || !pessoa.nomeCompleto || !pessoa.celular) {
    return {
      ok: false,
      code: 'MISSING_FIELDS',
      missing: [
        !pessoa.cpf && 'cpf',
        !pessoa.email && 'email',
        !pessoa.nomeCompleto && 'nome',
        !pessoa.celular && 'celular',
      ].filter(Boolean),
      error: 'Dados insuficientes para inscrição no portal matricula.sumare.edu.br',
      steps,
    }
  }

  const created = await criarPessoaCandidato(env, { oferta: ofertaRes.oferta, pessoa, token: login.token })
  steps.push({
    step: 'pessoa_candidato',
    ok: created.ok,
    candidato: created.candidato,
    idCandidato: created.idCandidato,
    reused: created.reused || false,
  })
  if (!created.ok) {
    return { ok: false, code: created.code, error: created.error, steps }
  }

  const educsyBody = {
    cpf: pessoa.cpf,
    celular: pessoa.celular,
    nomeCompleto: pessoa.nomeCompleto,
    email: pessoa.email,
    dataNascimento: pessoa.dtNascimento,
    sexo: pessoa.sexo,
    curso: ofertaRes.oferta.cursoCodigo,
    turno: ofertaRes.oferta.turno,
    unidade: ofertaRes.oferta.unidade,
    utmCampaign: ofertaRes.oferta.utm,
    tipoIngresso: 'Vestibular',
    concurso: ofertaRes.oferta.concurso,
    idCandidato: created.idCandidato,
    candidato: created.candidato,
  }
  const educsy = await registrarInscricaoEducsy(env, educsyBody)
  steps.push({
    step: 'inscricao_educsy',
    ok: educsy.ok,
    status: educsy.status,
    cobranca: educsy.data?.cobranca || null,
  })
  if (!educsy.ok) {
    return {
      ok: false,
      code: 'EDUCSY_INSCRICAO_FAILED',
      error: educsy.raw || educsy.error || `HTTP ${educsy.status}`,
      candidatoId: created.candidato,
      steps,
    }
  }

  if (created.idCandidato) {
    const sign = await softsyFetch(
      env,
      `/candidato-contrato/v1/assinar-sem-token/${created.idCandidato}`,
      { method: 'POST', token: login.token },
    )
    steps.push({ step: 'assinar_contrato', ok: sign.ok, status: sign.status })
  }

  const contractUrl = buildMatriculaPagamentoUrl(env, { cpf: pessoa.cpf })
  return {
    ok: true,
    candidatoId: created.candidato,
    idCandidato: created.idCandidato,
    cobranca: educsy.data?.cobranca || null,
    contractUrl,
    portalPhase: 'pagamento',
    candidatoStatus: 'meioPagamento',
    sameCourseInProgress: Boolean(created.reused),
    requestedCurso: { nome: snapshot?.curso_inscricao || ofertaRes.oferta.cursoNome, codigo: ofertaRes.oferta.cursoCodigo },
    cursoCodigo: ofertaRes.oferta.cursoCodigo,
    cursoNome: ofertaRes.oferta.cursoNome || snapshot?.curso_inscricao || '',
    steps,
    educsy: educsy.data,
  }
}
