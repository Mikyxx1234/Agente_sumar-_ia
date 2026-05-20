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

const DEFAULT_BOT_CONSULTOR = 49777
const DEFAULT_BOT_DISTRIBUICAO_FORM = 49777
const DEFAULT_BOT_MATRICULA_POS_FORM = 49813

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
        env.KOMMO_SALESBOT_INSCRICAO_START_ID ||
        env.KOMMO_SALESBOT_MATRICULA_POS_FORM_ID,
    )
    return Number.isFinite(id) && id > 0 ? id : DEFAULT_BOT_MATRICULA_POS_FORM
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

  const url = `${kommoBase.replace(/\/$/, '')}/api/v2/salesbot/run`
  const res = await fetch(url, {
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

  if (res.ok && opts.note) {
    await createLeadNote(env, leadId, opts.note).catch(() => {})
  }

  return {
    ok: res.ok,
    status: res.status,
    botId,
    motivo: kind,
    text: text.slice(0, 500),
  }
}
