/**
 * Plano_Inscricao_CardKommo — espelhamento do card Sumaré Comercial em
 * `dados_cliente_sum` (colunas kommo_*). Sempre que o card tem os
 * campos pre-preenchidos (`sum_Nome`, `sum_CPF`, `sum_Email`,
 * `sum_Curso`, etc.), gravamos uma cópia rastreável no banco para:
 *   - permitir o fluxo "express" (pular Form Sumar)
 *   - manter auditoria/telemetria (kommo_sync_at)
 *
 * TTL: 5 min — não re-grava em cada turno do mesmo lead (evita PATCH
 * desnecessário a cada mensagem do agente).
 */

import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import {
  ensureDadosClienteRow,
  fetchDadosClienteByTelefone,
  updateDadosCliente,
  getLeadIdByTelefone,
} from './dadosClienteStore.js'

const MIRROR_TTL_MS = 5 * 60 * 1000
const lastMirrorAt = new Map()

function mirrorCacheKey(telefone, leadId) {
  return `${String(telefone || '').replace(/\D/g, '')}::${leadId || 0}`
}

function shouldSkipByTtl(telefone, leadId) {
  const k = mirrorCacheKey(telefone, leadId)
  const prev = lastMirrorAt.get(k)
  if (!prev) return false
  return Date.now() - prev < MIRROR_TTL_MS
}

function markMirroredNow(telefone, leadId) {
  lastMirrorAt.set(mirrorCacheKey(telefone, leadId), Date.now())
}

function normalizeStr(v) {
  const s = String(v ?? '').trim()
  return s.length ? s : null
}

/**
 * Espelha o snapshot do card Kommo em `dados_cliente_sum` (cria a linha
 * caso não exista). Idempotente; respeita TTL para não escrever a cada
 * turno.
 *
 * @param {Record<string,string>} env
 * @param {object} input
 * @param {string} input.telefone
 * @param {number|string|null} [input.leadId]
 * @param {boolean} [input.force]  ignora TTL (forçar refresh)
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped?: boolean,
 *   reason?: string,
 *   snapshot?: object,
 *   row?: object,
 *   mirrored?: Record<string, any>,
 * }>}
 */
export async function mirrorKommoCardToDadosCliente(env, input) {
  const telefone = String(input?.telefone || '').trim()
  if (!telefone) return { ok: false, reason: 'missing_telefone' }

  let leadId = input?.leadId
  if (leadId == null || leadId === '') {
    leadId = await getLeadIdByTelefone(env, telefone)
  }
  const leadIdNum = Number(leadId)
  if (!Number.isFinite(leadIdNum) || leadIdNum <= 0) {
    return { ok: false, reason: 'missing_lead_id' }
  }

  if (!input?.force && shouldSkipByTtl(telefone, leadIdNum)) {
    return { ok: true, skipped: true, reason: 'ttl_cache' }
  }

  const snapRes = await fetchLeadFormSnapshot(env, leadIdNum)
  if (!snapRes.ok || !snapRes.snapshot) {
    return { ok: false, reason: snapRes.error || 'snapshot_unavailable' }
  }

  const s = snapRes.snapshot
  const mirrored = {
    kommo_nome: normalizeStr(s.nome),
    kommo_cpf: normalizeStr(s.cpf),
    kommo_email: normalizeStr(s.email),
    kommo_data_nasc: normalizeStr(s.data_nasc),
    kommo_curso: normalizeStr(s.curso_inscricao),
    kommo_polo: normalizeStr(s.polo_inscricao),
    kommo_modalidade: normalizeStr(s.modalidade || s.turno),
    kommo_status_inscricao: normalizeStr(s.status_inscricao),
    kommo_sync_at: new Date().toISOString(),
  }

  // Cria linha se não existir; PATCH com os campos kommo_*.
  const ensured = await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadIdNum,
    fields: mirrored,
  }).catch((err) => ({ ok: false, error: err?.message }))

  if (!ensured?.ok) {
    return { ok: false, reason: ensured?.code || ensured?.error || 'ensure_failed', mirrored }
  }

  markMirroredNow(telefone, leadIdNum)

  const row = await fetchDadosClienteByTelefone(env, telefone, '*').catch(() => null)
  return { ok: true, snapshot: s, row, mirrored }
}

/** Força refresh em testes (limpa o TTL). */
export function _resetKommoCardMirrorCache() {
  lastMirrorAt.clear()
}

/**
 * Heurística determinística: o card tem o conjunto mínimo de dados
 * para tentar o fluxo express (campos obrigatórios) E lista de campos
 * faltantes para telemetria.
 *
 * Decisão `campos_extras=sim_obrigatorios`: nome, cpf, email, curso,
 * polo, data_nasc, modalidade. Se faltar qualquer um, não tenta express.
 */
export function evaluateKommoExpressReadiness(snapshot) {
  const required = [
    ['nome', snapshot?.nome],
    ['cpf', snapshot?.cpf],
    ['email', snapshot?.email],
    ['curso', snapshot?.curso_inscricao],
    ['polo', snapshot?.polo_inscricao],
    ['data_nasc', snapshot?.data_nasc],
    ['modalidade', snapshot?.modalidade || snapshot?.turno],
  ]
  const missing = []
  for (const [key, val] of required) {
    const s = String(val ?? '').trim()
    if (!s || /^n[ãa]o informado\.?$/i.test(s) || /^n\/a$/i.test(s)) {
      missing.push(key)
    }
  }
  return {
    ready: missing.length === 0,
    missing,
  }
}

/** Atualiza apenas algumas colunas do mirror (ex.: ajustar polo após confirmação). */
export async function updateKommoMirrorFields(env, telefone, fields) {
  if (!telefone || !fields || typeof fields !== 'object') {
    return { ok: false, reason: 'invalid_args' }
  }
  const allowed = [
    'polo_inscricao_escolhido',
    'captacao_unidade',
    'kommo_polo',
    'kommo_modalidade',
    'kommo_sync_at',
  ]
  const out = {}
  for (const k of allowed) {
    if (k in fields) out[k] = fields[k]
  }
  if (Object.keys(out).length === 0) return { ok: false, reason: 'no_allowed_fields' }
  return updateDadosCliente(env, { telefone, fields: out })
}
