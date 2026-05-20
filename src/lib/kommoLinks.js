/**
 * URLs do Kommo CRM para abrir leads no navegador.
 * Defina VITE_KOMMO_BASE_URL no .env (mesmo valor de KOMMO_BASE_URL).
 */

const KOMMO_BASE = (import.meta.env.VITE_KOMMO_BASE_URL || '').replace(/\/$/, '')

export function getKommoBaseUrl() {
  return KOMMO_BASE
}

/** Monta URL do lead no painel Kommo. */
export function buildKommoLeadUrl(leadId) {
  if (!KOMMO_BASE || leadId == null || leadId === '') return null
  const id = String(leadId).trim()
  if (!/^\d+$/.test(id)) return null
  return `${KOMMO_BASE}/leads/detail/${id}`
}

/**
 * Extrai o ID do lead Kommo gravado na execução (lookup, tools, meta).
 */
export function extractLeadIdFromExecution(execution) {
  if (!execution) return null

  const steps = execution.steps || []
  const lookup = steps.find((s) => s?.tool === 'kommo.findLeadByPhone')
  if (lookup?.result?.leadId != null) return String(lookup.result.leadId)

  const meta = execution.aiMeta || {}
  if (meta.leadId != null) return String(meta.leadId)
  if (meta.kommo?.leadId != null) return String(meta.kommo.leadId)

  for (const tc of execution.toolCalls || []) {
    const args = tc.args || {}
    const fromArgs = args.id_lead ?? args.idLead ?? args.lead_id ?? args.leadId
    if (fromArgs != null) return String(fromArgs)

    if (tc.tool === 'inscricao' && tc.result) {
      const id = parseLeadIdFromToolResult(tc.result)
      if (id) return id
    }
  }

  for (const s of steps) {
    if (s?.result?.id_lead != null) return String(s.result.id_lead)
    if (s?.result?.leadId != null) return String(s.result.leadId)
  }

  return null
}

function parseLeadIdFromToolResult(result) {
  if (result == null) return null
  if (typeof result === 'object' && result.id_lead != null) return String(result.id_lead)
  if (typeof result !== 'string') return null
  try {
    const o = JSON.parse(result)
    if (o?.id_lead != null) return String(o.id_lead)
  } catch {
    const m = result.match(/id[_\s-]?lead["\s:]+(\d+)/i)
    if (m) return m[1]
  }
  return null
}

const INVALID_NAMES = new Set([
  'não informado', 'nao informado', 'n/a', 'na', '—', '-', 'null', 'undefined', '',
])

function isValidStudentName(value) {
  if (value == null) return false
  const t = String(value).trim()
  if (t.length < 2) return false
  if (INVALID_NAMES.has(t.toLowerCase())) return false
  return true
}

function parseNameFromToolResult(result) {
  if (result == null) return null
  let o = result
  if (typeof result === 'string') {
    try {
      o = JSON.parse(result)
    } catch {
      const m = result.match(/nome[_\s]*candidato["\s:]+([^"\n,]+)/i)
      return m && isValidStudentName(m[1]) ? m[1].trim() : null
    }
  }
  if (typeof o !== 'object') return null
  const candidates = [
    o?.resumo_campos?.nome_candidato,
    o?.nome_candidato,
    o?.nome,
    o?.leadName,
    o?.lead_name,
  ]
  for (const c of candidates) {
    if (isValidStudentName(c)) return String(c).trim()
  }
  return null
}

/**
 * Nome do aluno/lead a partir da execução gravada (usage, steps, tools).
 */
export function extractStudentNameFromExecution(execution) {
  if (!execution) return null

  const usage = execution.usage || {}
  for (const key of ['lead_name', 'leadName', 'nome_aluno', 'nome', 'student_name']) {
    if (isValidStudentName(usage[key])) return String(usage[key]).trim()
  }

  const meta = execution.aiMeta || {}
  for (const key of ['leadName', 'nome', 'nome_aluno', 'studentName']) {
    if (isValidStudentName(meta[key])) return String(meta[key]).trim()
  }
  if (isValidStudentName(meta.kommo?.leadName)) return String(meta.kommo.leadName).trim()

  for (const s of execution.steps || []) {
    if (isValidStudentName(s?.result?.leadName)) return String(s.result.leadName).trim()
    if (isValidStudentName(s?.result?.lead?.name)) return String(s.result.lead.name).trim()
    if (isValidStudentName(s?.result?.nome_fallback)) return String(s.result.nome_fallback).trim()
    if (s?.step === 'kommo_get_lead' && isValidStudentName(s?.nome_fallback)) {
      return String(s.nome_fallback).trim()
    }
  }

  for (const tc of execution.toolCalls || []) {
    const args = tc.args || {}
    if (isValidStudentName(args.nome)) return String(args.nome).trim()
    if (isValidStudentName(args.nome_candidato)) return String(args.nome_candidato).trim()
    const fromResult = parseNameFromToolResult(tc.result)
    if (fromResult) return fromResult
  }

  return null
}

/** Busca nome no Kommo quando não veio na execução (execuções antigas). */
export async function fetchKommoLeadName(leadId) {
  const id = String(leadId || '').trim()
  if (!/^\d+$/.test(id)) return null
  try {
    const res = await fetch(`/api/kommo/lead/${id}/summary`)
    const data = await res.json().catch(() => ({}))
    if (data.ok && isValidStudentName(data.name)) return String(data.name).trim()
  } catch {
    /* ignore */
  }
  return null
}
