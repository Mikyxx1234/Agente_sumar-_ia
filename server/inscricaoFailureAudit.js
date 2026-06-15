/**
 * Notas internas no Kommo quando matrícula/solicitação não pôde ser concluída.
 * Ajuda a diagnosticar falhas sem depender só de logs do servidor.
 */

import { createLeadAuditNote } from './kommoClient.js'
import { getLeadIdByTelefone } from './dadosClienteStore.js'

/** Estados esperados do fluxo — não geram nota de falha. */
export const INSCRICAO_AUDIT_SKIP_CODES = new Set([
  'TRANSFERENCIA_DADOS_FALTANDO',
  'POLO_NEEDED',
  'MATRICULA_RESUMO_PENDING',
  'MATRICULA_AUTHORIZATION_PENDING',
  'FORM_ALREADY_SENT',
])

/**
 * @param {object} env
 * @param {object} params
 * @param {number|null} [params.leadId]
 * @param {string} [params.telefone]
 * @param {string} params.code
 * @param {string} params.motivo
 * @param {string} [params.tool]
 * @param {string} [params.tipo='solicitação']
 * @param {string} [params.executionId]
 */
export async function recordInscricaoFailureAuditNote(env, params = {}) {
  const code = String(params.code || '').trim()
  if (!code || INSCRICAO_AUDIT_SKIP_CODES.has(code)) return { ok: false, skipped: true, reason: 'skip_code' }

  let leadId = Number(params.leadId)
  if (!Number.isFinite(leadId) || leadId <= 0) {
    const tel = String(params.telefone || '').trim()
    if (tel) {
      const fromDb = await getLeadIdByTelefone(env, tel).catch(() => null)
      if (fromDb != null) leadId = Number(fromDb)
    }
  }
  if (!Number.isFinite(leadId) || leadId <= 0) return { ok: false, skipped: true, reason: 'no_lead_id' }

  const tipo = String(params.tipo || 'solicitação').trim()
  const tool = params.tool ? ` | tool=${params.tool}` : ''
  const exec = params.executionId ? ` | exec=${params.executionId}` : ''
  const motivo = String(params.motivo || code).trim().slice(0, 500)
  const text =
    `[IA] ${tipo} não concluída — código: ${code}${tool}. ` +
    `Motivo: ${motivo}${exec}`

  return createLeadAuditNote(env, leadId, text).catch((err) => ({
    ok: false,
    error: err?.message || String(err),
  }))
}

/** Dispara nota de falha a partir do retorno padrão das action tools. */
export async function maybeAuditActionToolFailure(env, ctx = {}, result = {}) {
  if (!result || result.ok !== false) return
  await recordInscricaoFailureAuditNote(env, {
    leadId: ctx.leadId,
    telefone: ctx.telefone || ctx.argsTelefone,
    code: result.code,
    motivo: result.text || result.replyOverride || result.code,
    tool: result.ctxSnapshot?.inscricaoActionTool,
    tipo: 'matrícula/solicitação',
    executionId: ctx.executionId,
  })
}
