/**
 * Estado em memória do poll Kommo → buffer.
 *
 * Permite explicar para o operador: o poll RODOU, viu N notas, esses tipos,
 * filtrou esses, gravou tantas no buffer. Isso separa "código do poll não rodou"
 * de "rodou e o Kommo não tem notas inbound novas".
 */

const bootAt = Date.now()

/**
 * @typedef {{
 *   at: number,
 *   leadId: number,
 *   sessionId: string,
 *   warmedUp: boolean,
 *   notesTotal: number,
 *   typeCounts: Record<string, number>,
 *   freshCount: number,
 *   pushedCount: number,
 *   filteredByType: number,
 *   filteredEmpty: number,
 *   filteredOutbound: number,
 *   filteredOtherPhone: number,
 *   lastNoteId: number,
 *   pollMode: string,
 *   error?: string|null,
 * }} NotesTickSummary
 */

/**
 * @typedef {{
 *   at: number,
 *   leadId: number,
 *   sessionId: string,
 *   warmedUp: boolean,
 *   eventsTotal: number,
 *   typeCounts: Record<string, number>,
 *   freshCount: number,
 *   pushedCount: number,
 *   filteredEmpty: number,
 *   filteredOutbound: number,
 *   filteredOtherType: number,
 *   lastSeenAt: number,
 *   pollMode: string,
 *   requestUrl?: string|null,
 *   httpStatus?: number|null,
 *   error?: string|null,
 * }} EventsTickSummary
 */

/** @type {Map<number, NotesTickSummary>} */
const lastNotesByLead = new Map()
/** @type {Map<number, EventsTickSummary>} */
const lastEventsByLead = new Map()

/** @type {{ at: number, leadId: number, sessionId: string, ok: boolean, messages: number, error?: string }|null} */
let lastAmojoTick = null

let totalNotesTicks = 0
let totalEventsTicks = 0
let totalAmojoTicks = 0

export function recordNotesTick(summary) {
  totalNotesTicks += 1
  const safe = {
    ...summary,
    at: Date.now(),
    typeCounts: { ...(summary.typeCounts || {}) },
  }
  lastNotesByLead.set(Number(summary.leadId), safe)
}

export function recordEventsTick(summary) {
  totalEventsTicks += 1
  const safe = {
    ...summary,
    at: Date.now(),
    typeCounts: { ...(summary.typeCounts || {}) },
  }
  lastEventsByLead.set(Number(summary.leadId), safe)
}

export function recordAmojoTick(info) {
  totalAmojoTicks += 1
  lastAmojoTick = { ...info, at: Date.now() }
}

export function getKommoPollSnapshot() {
  const now = Date.now()
  const notesByLead = {}
  for (const [lid, s] of lastNotesByLead) {
    notesByLead[lid] = { ...s, ageSec: Math.round((now - s.at) / 1000) }
  }
  const eventsByLead = {}
  for (const [lid, s] of lastEventsByLead) {
    eventsByLead[lid] = { ...s, ageSec: Math.round((now - s.at) / 1000) }
  }
  return {
    uptimeSec: Math.round((now - bootAt) / 1000),
    totalNotesTicks,
    totalEventsTicks,
    totalAmojoTicks,
    lastAmojoTick: lastAmojoTick
      ? { ...lastAmojoTick, ageSec: Math.round((now - lastAmojoTick.at) / 1000) }
      : null,
    notesByLead,
    eventsByLead,
  }
}

/**
 * Linha curta para combinar com o log de "buffer vazio" do scheduler.
 * Foca no lead atual, se houver dados.
 */
export function formatPollDiagLine(leadId) {
  const lid = Number(leadId)
  const s = lastNotesByLead.get(lid)
  if (!s) {
    return `[poll-kommo][diag] lead=${lid} ainda_não_executou_poll_de_notas (aguarde 1 tick) totalTicks=${totalNotesTicks}`
  }
  const types = Object.entries(s.typeCounts || {})
    .map(([k, v]) => `${k}:${v}`)
    .join(',') || '(nenhum)'
  const ago = Math.round((Date.now() - s.at) / 1000)
  if (s.error) {
    return `[poll-kommo][diag] lead=${lid} ÚLTIMO ERRO: ${s.error} (há ${ago}s)`
  }
  if (!s.warmedUp) {
    return `[poll-kommo][diag] lead=${lid} warmup há ${ago}s — só mensagens NOVAS depois disso entram no buffer | notas existentes=${s.notesTotal} tipos=${types}`
  }
  const filtered = `filtradas: tipo=${s.filteredByType} vazias=${s.filteredEmpty} saída=${s.filteredOutbound} outroTel=${s.filteredOtherPhone}`
  let hint = ''
  const types2 = s.typeCounts || {}
  const onlyCommon =
    Object.keys(types2).length === 1 && Object.keys(types2)[0] === 'common'
  if (s.notesTotal === 0) {
    hint =
      ' | dica: lead sem notas; tente KOMMO_INBOUND_POLL_MODE=events (ou both) para ler do log de eventos do Kommo, que normalmente tem incoming_chat_message mesmo quando não vira nota.'
  } else if (s.pushedCount === 0 && s.filteredByType > 0 && onlyCommon) {
    hint =
      ' | dica: todas as notas são "common" (WhatsApp deste setup grava mensagens como common). Ative KOMMO_INBOUND_POLL_INCLUDE_COMMON=true e adicione common em KOMMO_INBOUND_POLL_NOTE_TYPES.'
  } else if (s.pushedCount === 0 && s.filteredByType > 0) {
    hint = ` | dica: notas presentes mas tipo não cobre; ajuste KOMMO_INBOUND_POLL_NOTE_TYPES com os tipos vistos acima.`
  } else if (s.pushedCount === 0 && s.notesTotal > 0 && s.freshCount === 0) {
    hint = ` | nada novo desde lastNoteId=${s.lastNoteId} (há ${ago}s)`
  }
  return `[poll-kommo][diag] lead=${lid} mode=${s.pollMode} notas=${s.notesTotal} tipos=${types} fresh=${s.freshCount} pushed=${s.pushedCount} ${filtered} lastNoteId=${s.lastNoteId} (há ${ago}s)${hint}`
}

/**
 * Linha de diagnóstico do modo `events` (log nativo do Kommo).
 */
export function formatEventsDiagLine(leadId) {
  const lid = Number(leadId)
  const s = lastEventsByLead.get(lid)
  if (!s) {
    return `[poll-kommo][events][diag] lead=${lid} ainda_não_executou_poll_de_eventos (aguarde 1 tick) totalTicks=${totalEventsTicks}`
  }
  const types = Object.entries(s.typeCounts || {})
    .map(([k, v]) => `${k}:${v}`)
    .join(',') || '(nenhum)'
  const ago = Math.round((Date.now() - s.at) / 1000)
  if (s.error) {
    return `[poll-kommo][events][diag] lead=${lid} ÚLTIMO ERRO: ${s.error} status=${s.httpStatus || '?'} (há ${ago}s) url=${s.requestUrl || 'n/a'}`
  }
  if (!s.warmedUp) {
    return `[poll-kommo][events][diag] lead=${lid} warmup há ${ago}s — só eventos NOVOS depois disso entram no buffer | eventos existentes=${s.eventsTotal} tipos=${types} lastSeenAt=${s.lastSeenAt}`
  }
  const filtered = `filtrados: vazios=${s.filteredEmpty} saída=${s.filteredOutbound} outroTipo=${s.filteredOtherType}`
  let hint = ''
  if (s.eventsTotal === 0 && s.freshCount === 0) {
    hint =
      ' | dica: zero eventos retornados — sua integração WhatsApp pode não emitir incoming_chat_message no log do Kommo. Confirme abrindo /api/kommo/poll/events?leadId=' +
      lid +
      '. Se vier vazio, parta para mode=amojo.'
  } else if (s.pushedCount === 0 && s.eventsTotal > 0 && s.freshCount === 0) {
    hint = ` | nada novo desde lastSeenAt=${s.lastSeenAt} (há ${ago}s)`
  } else if (s.pushedCount === 0 && s.filteredEmpty > 0) {
    hint = ` | dica: eventos chegaram mas value_after veio sem texto — algumas integrações não preenchem o body. Ative log de payload e/ou tente mode=amojo.`
  }
  return `[poll-kommo][events][diag] lead=${lid} mode=${s.pollMode} eventos=${s.eventsTotal} tipos=${types} fresh=${s.freshCount} pushed=${s.pushedCount} ${filtered} lastSeenAt=${s.lastSeenAt} (há ${ago}s)${hint}`
}
