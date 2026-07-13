/**
 * Disparo de Salesbots no Kommo (POST /api/v2/salesbot/run).
 *
 * IDs padrão Sumaré:
 *   consultor / dúvida humana     → 49777
 *   formulário inscrição (início) → KOMMO_SALESBOT_FORMULARIO_SUM_ID (obrigatório no .env)
 *   distribuição pós-formulário   → KOMMO_SALESBOT_DISTRIBUICAO_FORM_ID
 *   pós formulário validado       → 49813 (matrícula)
 */

import { createLeadNote } from './kommoClient.js'
import { kommoRawFetch } from './kommoRateLimiter.js'
import { getMessageBufferRedis } from './evolution/messageBuffer.js'
import { API_SUMARE_SALESBOT_PAGAMENTO_ID } from '../libShared/apiSumareOrigemHeuristics.js'

const DEFAULT_BOT_CONSULTOR = 49777
const DEFAULT_BOT_DISTRIBUICAO_FORM = 49777
const DEFAULT_BOT_MATRICULA_POS_FORM = 49813
const DEFAULT_BOT_AGUARD_PGT_API = API_SUMARE_SALESBOT_PAGAMENTO_ID

/** Evita disparar o mesmo salesbot no mesmo lead em loop (scheduler ~10s). */
const _salesbotRunCache = new Map()
/** Coalesce chamadas paralelas (race antes do cache ser gravado). */
const _salesbotInflight = new Map()

function salesbotDedupeMs(env, kind) {
  const global = Number(env.KOMMO_SALESBOT_MIN_INTERVAL_SEC)
  if (Number.isFinite(global) && global > 0) return global * 1000
  if (kind === 'formulario_sum') return 6 * 60 * 60 * 1000
  if (kind === 'aguard_pgt_api_sumare') return 24 * 60 * 60 * 1000
  if (kind === 'matricula_pos_form') return 24 * 60 * 60 * 1000
  if (kind === 'distribuicao_pos_form') return 30 * 60 * 1000
  return 60 * 60 * 1000
}

export function normalizeSalesbotMotivo(motivo) {
  const m = String(motivo || 'consultor')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
  if (['matricula_pos_form', 'pos_form', 'apos_formulario', 'form_completed', 'matricula', '49813'].includes(m)) {
    return 'matricula_pos_form'
  }
  if (
    [
      'distribuicao_pos_form',
      'distribuir_pos_form',
      'distribuir_lead',
      'distribuicao_form',
      'distribuicao',
    ].includes(m)
  ) {
    return 'distribuicao_pos_form'
  }
  if (
    [
      'aguard_pgt_api_sumare',
      'aguard_pgt_api',
      'aguard_pgt_sumare_api',
      'bv_aguard_pgt_sumare_api',
      '49979',
    ].includes(m)
  ) {
    return 'aguard_pgt_api_sumare'
  }
  if (
    [
      'formulario_sum',
      'formulario_sumar',
      'form_sumar',
      'form_sumar_start',
      'inscricao_form',
      'matricula',
      'inscricao',
      'inscricao_ab',
      'enrollment',
    ].includes(m)
  ) {
    return 'formulario_sum'
  }
  return 'consultor'
}

/** Resolve bot_id conforme motivo do fluxo. */
export function resolveSalesbotBotId(env, motivo) {
  const kind = normalizeSalesbotMotivo(motivo)
  if (kind === 'distribuicao_pos_form') {
    const id = Number(
      env.KOMMO_SALESBOT_DISTRIBUICAO_FORM_ID ||
        env.KOMMO_SALESBOT_DISTRIBUICAO_ID ||
        env.KOMMO_SALESBOT_DISTRIBUIR_ID,
    )
    return Number.isFinite(id) && id > 0 ? id : DEFAULT_BOT_DISTRIBUICAO_FORM
  }
  if (kind === 'matricula_pos_form') {
    const id = Number(
      env.KOMMO_SALESBOT_MATRICULA_POS_FORM_ID ||
        env.KOMMO_SALESBOT_MATRICULA_ID ||
        env.KOMMO_SALESBOT_ID_MATRICULA ||
        env.KOMMO_SALESBOT_BOT_ID_MATRICULA,
    )
    return Number.isFinite(id) && id > 0 ? id : DEFAULT_BOT_MATRICULA_POS_FORM
  }
  if (kind === 'formulario_sum') {
    const id = Number(
      env.KOMMO_SALESBOT_FORMULARIO_SUM_ID ||
        env.KOMMO_SALESBOT_FORM_SUMAR_ID ||
        env.KOMMO_SALESBOT_INSCRICAO_FORM_ID ||
        env.KOMMO_SALESBOT_INSCRICAO_START_ID,
    )
    return Number.isFinite(id) && id > 0 ? id : 0
  }
  if (kind === 'aguard_pgt_api_sumare') {
    const id = Number(
      env.KOMMO_SALESBOT_AGUARD_PGT_API_ID ||
        env.KOMMO_SALESBOT_PAGAMENTO_API_ID ||
        env.KOMMO_SALESBOT_API_PAGAMENTO_ID,
    )
    return Number.isFinite(id) && id > 0 ? id : DEFAULT_BOT_AGUARD_PGT_API
  }
  const id = Number(
    env.KOMMO_SALESBOT_DISTRIBUIR_ID ||
      env.KOMMO_SALESBOT_CONSULTOR_ID ||
      env.KOMMO_SALESBOT_ID_CONSULTOR ||
      env.KOMMO_SALESBOT_BOT_ID_CONSULTOR,
  )
  return Number.isFinite(id) && id > 0 ? id : DEFAULT_BOT_CONSULTOR
}

/**
 * @param {Record<string,string>} env
 * @param {number} idLead
 * @param {string} [motivo]
 * @param {{ executionId?: string, note?: string }} [opts]
 */
export async function runKommoSalesbot(env, idLead, motivo = 'consultor', opts = {}) {
  const leadId = Number(idLead)
  if (!Number.isFinite(leadId) || leadId <= 0) {
    return { ok: false, skipped: true, reason: 'invalid_lead_id' }
  }
  const kommoBase = env.KOMMO_BASE_URL || ''
  const kommoToken = env.KOMMO_ACCESS_TOKEN || ''
  if (!kommoBase || !kommoToken) {
    return { ok: false, skipped: true, reason: 'kommo_not_configured' }
  }

  const kind = normalizeSalesbotMotivo(motivo)
  const botId = resolveSalesbotBotId(env, motivo)
  if (!botId) {
    return {
      ok: false,
      skipped: true,
      reason: 'missing_bot_id',
      code: kind === 'formulario_sum' ? 'MISSING_FORMULARIO_SUM_BOT_ID' : 'MISSING_SALESBOT_BOT_ID',
      motivo: kind,
    }
  }

  const dedupeKey = `${leadId}:${kind}:${botId}`
  const inflight = _salesbotInflight.get(dedupeKey)
  if (inflight) return inflight

  const promise = runKommoSalesbotOnce(env, {
    leadId,
    kind,
    botId,
    dedupeKey,
    kommoBase,
    kommoToken,
    note: opts.note,
    force: Boolean(opts.force),
  })
  _salesbotInflight.set(dedupeKey, promise)
  try {
    return await promise
  } finally {
    _salesbotInflight.delete(dedupeKey)
  }
}

async function tryRedisSalesbotDedupe(env, dedupeKey, dedupeMs) {
  try {
    const { client, keyPrefix } = await getMessageBufferRedis(env)
    if (!client) return { allow: true, reason: 'no_redis' }
    const key = `${keyPrefix || 'wa:msg:'}salesbot:run:v1:${dedupeKey}`
    const ttlSec = Math.max(60, Math.ceil(dedupeMs / 1000))
    const res = await client.set(key, String(Date.now()), 'EX', ttlSec, 'NX')
    if (res === 'OK') return { allow: true, reason: 'redis_nx' }
    return { allow: false, reason: 'redis_busy' }
  } catch (err) {
    console.warn('[kommoSalesbot] redis dedupe falhou:', err.message)
    return { allow: true, reason: 'redis_error_allow' }
  }
}

async function runKommoSalesbotOnce(env, ctx) {
  const { leadId, kind, botId, dedupeKey, kommoBase, kommoToken, note, force } = ctx
  const lastRun = _salesbotRunCache.get(dedupeKey)
  const dedupeMs = salesbotDedupeMs(env, kind)
  if (!force && lastRun && Date.now() - lastRun < dedupeMs) {
    console.log(
      `[kommoSalesbot] dedupe lead=${leadId} bot=${botId} motivo=${kind} (${Math.round((Date.now() - lastRun) / 1000)}s < ${Math.round(dedupeMs / 1000)}s)`,
    )
    return {
      ok: true,
      skipped: true,
      reason: 'dedupe_recent',
      botId,
      motivo: kind,
      text: 'salesbot já disparado recentemente para este lead',
    }
  }

  if (!force) {
    const redisDedupe = await tryRedisSalesbotDedupe(env, dedupeKey, dedupeMs)
    if (!redisDedupe.allow) {
      _salesbotRunCache.set(dedupeKey, Date.now())
      console.log(
        `[kommoSalesbot] dedupe redis lead=${leadId} bot=${botId} motivo=${kind} (${redisDedupe.reason})`,
      )
      return {
        ok: true,
        skipped: true,
        reason: 'dedupe_redis',
        botId,
        motivo: kind,
        text: 'salesbot já disparado recentemente para este lead (redis)',
      }
    }
  }

  _salesbotRunCache.set(dedupeKey, Date.now())

  const url = `${kommoBase.replace(/\/$/, '')}/api/v2/salesbot/run`
  const res = await kommoRawFetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${kommoToken}`,
    },
    body: JSON.stringify([{ entity_type: 'leads', entity_id: leadId, bot_id: botId }]),
  })
  const text = await res.text()
  console.log(
    `[kommoSalesbot] run lead=${leadId} bot=${botId} motivo=${kind} ok=${res.ok} status=${res.status} body=${text.slice(0, 120)}`,
  )

  if (!res.ok) {
    _salesbotRunCache.delete(dedupeKey)
  } else if (note) {
    await createLeadNote(env, leadId, note).catch(() => {})
  }

  return {
    ok: res.ok,
    status: res.status,
    botId,
    motivo: kind,
    text: text.slice(0, 500),
  }
}
