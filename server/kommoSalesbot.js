/**
 * Disparo de Salesbots no Kommo (POST /api/v2/salesbot/run).
 *
 * IDs padrão Sumaré:
 *   consultor / dúvida humana → 49777
 *   pós Form Sumar (inscrição)  → 49815 (49813 descontinuado)
 */

const DEFAULT_BOT_CONSULTOR = 49777
const DEFAULT_BOT_MATRICULA_POS_FORM = 49815

export function normalizeSalesbotMotivo(motivo) {
  const m = String(motivo || 'consultor')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
  if (['matricula_pos_form', 'pos_form', 'apos_formulario', 'form_sumar', 'form_completed'].includes(m)) {
    return 'matricula_pos_form'
  }
  if (['matricula', 'inscricao', 'inscricao_ab', 'enrollment', 'inscricao_form'].includes(m)) {
    return 'inscricao_form'
  }
  return 'consultor'
}

/** Resolve bot_id conforme motivo do fluxo. */
export function resolveSalesbotBotId(env, motivo) {
  const kind = normalizeSalesbotMotivo(motivo)
  if (kind === 'matricula_pos_form') {
    const id = Number(
      env.KOMMO_SALESBOT_MATRICULA_POS_FORM_ID ||
        env.KOMMO_SALESBOT_MATRICULA_ID ||
        env.KOMMO_SALESBOT_ID_MATRICULA ||
        env.KOMMO_SALESBOT_BOT_ID_MATRICULA,
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
 * @param {'consultor'|'matricula'|string} [motivo]
 */
export async function runKommoSalesbot(env, idLead, motivo = 'consultor') {
  const leadId = Number(idLead)
  if (!Number.isFinite(leadId) || leadId <= 0) {
    return { ok: false, skipped: true, reason: 'invalid_lead_id' }
  }
  const kommoBase = env.KOMMO_BASE_URL || ''
  const kommoToken = env.KOMMO_ACCESS_TOKEN || ''
  if (!kommoBase || !kommoToken) {
    return { ok: false, skipped: true, reason: 'kommo_not_configured' }
  }

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
  return {
    ok: res.ok,
    status: res.status,
    botId,
    motivo: normalizeSalesbotMotivo(motivo),
    text: text.slice(0, 500),
  }
}
