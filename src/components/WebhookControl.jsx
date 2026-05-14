import { useState, useEffect, useCallback } from 'react'
import { Activity, RefreshCw, CheckCircle2, AlertTriangle, XCircle, Server, Send } from 'lucide-react'

// Converte segundos em string legível. Null/undefined → "nunca".
function formatAge(sec) {
  if (sec == null) return 'nunca'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  if (sec < 86400) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return `${h}h ${m}m`
  }
  return `${Math.floor(sec / 86400)}d`
}

function Pill({ status, label }) {
  const bg =
    status === 'ok' ? 'var(--success-soft, rgba(52,211,153,.15))' :
    status === 'warn' ? 'var(--warn-soft, rgba(251,191,36,.15))' :
    status === 'fail' ? 'var(--danger-soft, rgba(248,113,113,.15))' :
    'var(--bg-3, #2a2a2a)'
  const color =
    status === 'ok' ? 'var(--success, #34d399)' :
    status === 'warn' ? 'var(--warn, #fbbf24)' :
    status === 'fail' ? 'var(--danger, #f87171)' :
    'var(--fg-3, #888)'
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      background: bg,
      color,
      display: 'inline-block',
    }}>
      {label}
    </span>
  )
}

function StatusIcon({ status, size = 14 }) {
  if (status === 'ok') return <CheckCircle2 size={size} style={{ color: 'var(--success, #34d399)' }} />
  if (status === 'warn') return <AlertTriangle size={size} style={{ color: 'var(--warn, #fbbf24)' }} />
  if (status === 'fail') return <XCircle size={size} style={{ color: 'var(--danger, #f87171)' }} />
  return <Server size={size} style={{ color: 'var(--fg-3, #888)' }} />
}

// Calcula o status global a partir do snapshot de health.
function computeGlobalStatus(data) {
  if (!data) return 'ok'

  const scheduler = data.scheduler || {}
  const diag = data.webhookDiagnostics || {}
  const fwd = data.webhookForwarder || {}
  const lastAsyncError = diag.lastAsyncError

  if (
    scheduler.running === false ||
    (fwd.urls || []).some((u) => u.status === 'fail') ||
    (lastAsyncError && lastAsyncError.ageSec < 120)
  ) {
    return 'fail'
  }

  if (
    (fwd.urls || []).some((u) => u.status === 'warn') ||
    (diag.lastIngress && diag.lastIngress.ageSec > 600) ||
    (lastAsyncError && lastAsyncError.ageSec < 600)
  ) {
    return 'warn'
  }

  return 'ok'
}

const GLOBAL_STATUS_LABEL = {
  ok: 'Tudo correndo bem',
  warn: 'Atenção: atrasos ou erros leves',
  fail: 'Problema crítico — verificar',
}

export default function WebhookControl() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastFetchAt, setLastFetchAt] = useState(null)

  const fetchHealth = useCallback(async () => {
    try {
      const r = await fetch('/api/evolution/health')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      setData(j)
      setLastFetchAt(Date.now())
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchHealth()
    const id = setInterval(fetchHealth, 5000)
    return () => clearInterval(id)
  }, [fetchHealth])

  const diag = data?.webhookDiagnostics || {}
  const fwd = data?.webhookForwarder || {}
  const scheduler = data?.scheduler || {}
  const globalStatus = computeGlobalStatus(data)

  const lastIngress = diag.lastIngress
  const lastSync = diag.lastSyncOutcome
  const lastBuffer = diag.lastBufferWrite
  const lastAsyncError = diag.lastAsyncError

  return (
    <div style={{ padding: '24px 28px', maxWidth: 960, margin: '0 auto' }}>
      {/* ── Cabeçalho ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={18} style={{ color: 'var(--accent)' }} />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Controle Webhook</h2>
          </div>
          <div className="card-title-sub" style={{ marginTop: 2 }}>
            Saúde do recebimento, repasse e processamento
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {data && <Pill status={globalStatus} label={GLOBAL_STATUS_LABEL[globalStatus]} />}
          <button
            className="btn-icon"
            style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={fetchHealth}
            title="Atualizar"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {loading && !data && (
        <div className="state-msg">
          <div className="loader" />
          <p>Carregando...</p>
        </div>
      )}

      {error && (
        <div className="state-msg">
          <p style={{ color: 'var(--danger)' }}>Erro ao carregar health: {error}</p>
        </div>
      )}

      {data && (
        <>
          {/* ── KPIs ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            {/* Posts recebidos */}
            <div className="kpi">
              <div className="kpi-head">
                <div className="kpi-label">
                  <Activity size={13} />
                  <span>Posts recebidos</span>
                </div>
              </div>
              <div className="kpi-value tnum">{diag.webhookPostCount ?? '—'}</div>
              <div className="kpi-sub">
                {lastIngress ? `há ${formatAge(lastIngress.ageSec)}` : 'nunca'}
              </div>
            </div>

            {/* Último processamento */}
            <div className="kpi">
              <div className="kpi-head">
                <div className="kpi-label">
                  <CheckCircle2 size={13} />
                  <span>Último processamento</span>
                </div>
              </div>
              <div className="kpi-value tnum" style={{ fontSize: 13 }}>
                {lastSync ? lastSync.outcome : '—'}
              </div>
              <div className="kpi-sub">
                {lastSync
                  ? `event=${lastSync.event ?? '?'} • há ${formatAge(lastSync.ageSec)}`
                  : 'nunca'}
              </div>
            </div>

            {/* Último push no buffer */}
            <div className="kpi">
              <div className="kpi-head">
                <div className="kpi-label">
                  <Server size={13} />
                  <span>Último push buffer</span>
                </div>
              </div>
              <div className="kpi-value tnum" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {lastBuffer
                  ? lastBuffer.sessionId.slice(0, 16) + (lastBuffer.sessionId.length > 16 ? '…' : '')
                  : '—'}
              </div>
              <div className="kpi-sub">
                {lastBuffer ? `há ${formatAge(lastBuffer.ageSec)}` : 'nunca'}
              </div>
            </div>

            {/* Scheduler */}
            <div className="kpi">
              <div className="kpi-head">
                <div className="kpi-label">
                  <AlertTriangle size={13} />
                  <span>Scheduler</span>
                </div>
              </div>
              <div className="kpi-value tnum" style={{
                color: scheduler.running ? 'var(--success, #34d399)' : 'var(--danger, #f87171)',
              }}>
                {scheduler.running ? 'ON' : 'OFF'}
              </div>
              <div className="kpi-sub">
                intervalo {scheduler.intervalSec ?? '?'}s
              </div>
            </div>
          </div>

          {/* ── Card: Repasse para n8n / fan-out ── */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Send size={15} style={{ color: 'var(--accent)' }} />
              <span style={{ fontWeight: 600, fontSize: 14 }}>Repasse para n8n (fan-out)</span>
            </div>

            {(!fwd.enabled || fwd.configuredCount === 0) ? (
              <div className="empty" style={{ padding: '16px 0' }}>
                Fan-out desligado — configure <code>EVOLUTION_WEBHOOK_FORWARD_URL</code> no .env
              </div>
            ) : (
              <>
                {/* Totais globais */}
                <div style={{ display: 'flex', gap: 20, marginBottom: 14, fontSize: 13, flexWrap: 'wrap' }}>
                  <span>Tentativas: <strong className="tnum">{fwd.totalAttempts}</strong></span>
                  <span>Sucesso: <strong className="tnum" style={{ color: 'var(--success, #34d399)' }}>{fwd.totalSuccess}</strong></span>
                  <span>Falhas: <strong className="tnum" style={{ color: fwd.totalFailure > 0 ? 'var(--danger, #f87171)' : undefined }}>{fwd.totalFailure}</strong></span>
                  {fwd.totalAttempts > 0 && (
                    <span>Taxa de sucesso: <strong className="tnum">{((fwd.totalSuccess / fwd.totalAttempts) * 100).toFixed(1)}%</strong></span>
                  )}
                  {(fwd.skippedByEvent > 0 || fwd.skippedByFromMe > 0) && (
                    <span style={{ color: 'var(--fg-3, #888)' }}>
                      Filtrados: <strong className="tnum">{(fwd.skippedByEvent || 0) + (fwd.skippedByFromMe || 0)}</strong>
                      <span style={{ marginLeft: 4, fontSize: 11 }}>
                        (evento: {fwd.skippedByEvent || 0} · fromMe: {fwd.skippedByFromMe || 0})
                      </span>
                    </span>
                  )}
                </div>

                {/* Tabela por URL */}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: 'var(--fg-3, #888)', borderBottom: '1px solid var(--line-subtle)' }}>
                        <th style={{ textAlign: 'left', padding: '4px 8px 4px 0', fontWeight: 500 }}>Status</th>
                        <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>URL</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Tent.</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>OK</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Falha</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Falha%</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Avg ms</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>P95 ms</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Max ms</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Último OK</th>
                        <th style={{ textAlign: 'left', padding: '4px 0 4px 8px', fontWeight: 500 }}>Último erro</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(fwd.urls || []).map((u, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--line-subtle)' }}>
                          <td style={{ padding: '6px 8px 6px 0' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <StatusIcon status={u.status} size={13} />
                              <Pill status={u.status} label={u.status} />
                            </div>
                          </td>
                          <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 11, color: 'var(--fg-2)' }}>
                            {u.urlMasked}
                          </td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px' }}>{u.attemptCount}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: u.successCount > 0 ? 'var(--success, #34d399)' : undefined }}>{u.successCount}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: u.failureCount > 0 ? 'var(--danger, #f87171)' : undefined }}>{u.failureCount}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: u.failureRate > 0.05 ? 'var(--warn, #fbbf24)' : undefined }}>
                            {(u.failureRate * 100).toFixed(1)}%
                          </td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px' }}>{u.latencyAvgMs ?? '—'}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px' }}>{u.latencyP95Ms ?? '—'}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px' }}>{u.latencyMaxMs ?? '—'}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--fg-3, #888)' }}>
                            {u.lastSuccessAgeSec != null ? `há ${formatAge(u.lastSuccessAgeSec)}` : '—'}
                          </td>
                          <td style={{ padding: '6px 0 6px 8px', color: u.lastError ? 'var(--danger, #f87171)' : 'var(--fg-3, #888)', fontSize: 11 }}>
                            {u.lastError
                              ? `${u.lastError}${u.lastStatus ? ` (${u.lastStatus})` : ''}`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {/* ── Card: Erros recentes ── */}
          {lastAsyncError && lastAsyncError.ageSec < 1800 && (
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <XCircle size={15} style={{ color: 'var(--danger, #f87171)' }} />
                <span style={{ fontWeight: 600, fontSize: 14 }}>Erro recente</span>
                <span className="card-title-sub" style={{ marginLeft: 4 }}>
                  há {formatAge(lastAsyncError.ageSec)}
                </span>
              </div>
              <div style={{ fontSize: 12, display: 'grid', gap: 4 }}>
                <div><strong>Onde:</strong> <code>{lastAsyncError.where}</code></div>
                <div style={{ color: 'var(--danger, #f87171)' }}>{lastAsyncError.message}</div>
              </div>
            </div>
          )}

          {lastFetchAt && (
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--fg-3, #888)' }}>
              Atualizado às {new Date(lastFetchAt).toLocaleTimeString('pt-BR')} · polling a cada 5s
            </div>
          )}
        </>
      )}
    </div>
  )
}
