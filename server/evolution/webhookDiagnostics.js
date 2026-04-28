/**
 * Estado em memória para debug: último POST no webhook Evolution, outcomes
 * síncronos e última gravação bem-sucedida no message buffer.
 *
 * Ajuda a separar "webhook não chega neste servidor" de "chega mas descarta
 * ou grava em outra session".
 */

const bootAt = Date.now()

let requestCount = 0
/** @type {{ at: number, bodyKeyCount: number, contentType: string }|null} */
let lastIngress = null
/** @type {{ at: number, event: string|null, instance: string|null, outcome: string, detail: string|null }|null} */
let lastSyncOutcome = null
/** @type {{ at: number, sessionId: string }|null} */
let lastBufferWrite = null
/** @type {{ at: number, where: string, message: string }|null} */
let lastAsyncError = null

export function recordWebhookIngress({ bodyKeyCount = 0, contentType = '' } = {}) {
  requestCount += 1
  lastIngress = {
    at: Date.now(),
    bodyKeyCount: Number(bodyKeyCount) || 0,
    contentType: String(contentType || ''),
  }
}

/**
 * @param {{ event?: string|null, instance?: string|null, outcome: string, detail?: string|null }} p
 */
export function recordSyncOutcome({ event, instance, outcome, detail = null }) {
  lastSyncOutcome = {
    at: Date.now(),
    event: event != null ? String(event) : null,
    instance: instance != null ? String(instance) : null,
    outcome: String(outcome),
    detail: detail != null ? String(detail).slice(0, 400) : null,
  }
}

export function recordBufferWrite(sessionId) {
  if (!sessionId) return
  lastBufferWrite = { at: Date.now(), sessionId: String(sessionId) }
}

export function recordAsyncError(where, message) {
  lastAsyncError = {
    at: Date.now(),
    where: String(where || 'async'),
    message: String(message || '').slice(0, 400),
  }
}

export function getWebhookDiagnosticsSnapshot() {
  const now = Date.now()
  return {
    uptimeSec: Math.round((now - bootAt) / 1000),
    webhookPostCount: requestCount,
    lastIngress: lastIngress
      ? {
          ...lastIngress,
          ageSec: Math.round((now - lastIngress.at) / 1000),
        }
      : null,
    lastSyncOutcome: lastSyncOutcome
      ? {
          ...lastSyncOutcome,
          ageSec: Math.round((now - lastSyncOutcome.at) / 1000),
        }
      : null,
    lastBufferWrite: lastBufferWrite
      ? {
          ...lastBufferWrite,
          ageSec: Math.round((now - lastBufferWrite.at) / 1000),
        }
      : null,
    lastAsyncError: lastAsyncError
      ? {
          ...lastAsyncError,
          ageSec: Math.round((now - lastAsyncError.at) / 1000),
        }
      : null,
  }
}

/**
 * Texto único para o scheduler (whitelist + buffer vazio).
 */
export function formatSchedulerDiagnosticLine() {
  const now = Date.now()
  const parts = []
  parts.push(`uptime_s=${Math.round((now - bootAt) / 1000)}`)
  parts.push(`webhook_posts=${requestCount}`)

  if (!lastIngress) {
    parts.push(
      'webhook=NUNCA_RECEBEU_POST neste processo → conferir na Evolution URL https://SEU_DOMINIO/api/evolution/webhook, SSL e se o deploy é este container',
    )
    return `[scheduler][diag] ${parts.join(' | ')}`
  }

  parts.push(`ultimo_POST_ha_s=${Math.round((now - lastIngress.at) / 1000)} bodyKeys=${lastIngress.bodyKeyCount}`)

  if (lastSyncOutcome) {
    const d = lastSyncOutcome.detail ? ` detalhe=${lastSyncOutcome.detail}` : ''
    const inst = lastSyncOutcome.instance ? ` instance=${lastSyncOutcome.instance}` : ''
    parts.push(
      `ultimo_handler event=${lastSyncOutcome.event} → ${lastSyncOutcome.outcome}${d}${inst} (há ${Math.round((now - lastSyncOutcome.at) / 1000)}s)`,
    )
  } else {
    parts.push('ultimo_handler=(não registrado)')
  }

  if (lastBufferWrite) {
    parts.push(
      `ultimo_push_buffer há ${Math.round((now - lastBufferWrite.at) / 1000)}s session=${lastBufferWrite.sessionId}`,
    )
  } else {
    parts.push('ultimo_push_buffer=NUNCA (mensagem não chegou a ser gravada no Supabase/redis deste serviço)')
  }

  if (lastAsyncError && now - lastAsyncError.at < 300000) {
    parts.push(`ultimo_erro_async ${lastAsyncError.where}: ${lastAsyncError.message}`)
  }

  return `[scheduler][diag] ${parts.join(' | ')}`
}
