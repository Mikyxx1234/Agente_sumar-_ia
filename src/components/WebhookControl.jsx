import { useState, useEffect, useCallback } from 'react'
import {
  Activity, RefreshCw, CheckCircle2, AlertTriangle, XCircle, Server, Send,
  Inbox, Zap, Filter,
} from 'lucide-react'

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

const STATUS_COLOR = {
  ok:   { bg: 'var(--success-soft)', fg: 'var(--success)' },
  warn: { bg: 'var(--warn-soft)',    fg: 'var(--warn)' },
  fail: { bg: 'var(--danger-soft)',  fg: 'var(--danger)' },
  idle: { bg: 'var(--bg-3)',         fg: 'var(--fg-3)' },
}

function Pill({ status, label, big = false }) {
  const c = STATUS_COLOR[status] || STATUS_COLOR.idle
  return (
    <span style={{
      padding: big ? '4px 12px' : '2px 8px',
      borderRadius: 999,
      fontSize: big ? 12 : 11,
      fontWeight: 600,
      background: c.bg,
      color: c.fg,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      lineHeight: 1.2,
    }}>
      {label}
    </span>
  )
}

function StatusIcon({ status, size = 14 }) {
  if (status === 'ok')   return <CheckCircle2 size={size} style={{ color: 'var(--success)' }} />
  if (status === 'warn') return <AlertTriangle size={size} style={{ color: 'var(--warn)' }} />
  if (status === 'fail') return <XCircle size={size} style={{ color: 'var(--danger)' }} />
  return <Server size={size} style={{ color: 'var(--fg-3)' }} />
}

function computeGlobalStatus(data) {
  if (!data) return 'idle'
  const scheduler = data.scheduler || {}
  const diag = data.webhookDiagnostics || {}
  const fwd = data.webhookForwarder || {}
  const lastAsyncError = diag.lastAsyncError

  if (
    scheduler.running === false ||
    (fwd.urls || []).some((u) => u.status === 'fail') ||
    (lastAsyncError && lastAsyncError.ageSec < 120)
  ) return 'fail'

  if (
    (fwd.urls || []).some((u) => u.status === 'warn') ||
    (diag.lastIngress && diag.lastIngress.ageSec > 600) ||
    (lastAsyncError && lastAsyncError.ageSec < 600)
  ) return 'warn'

  return 'ok'
}

const GLOBAL_STATUS_LABEL = {
  ok:   'Tudo correndo bem',
  warn: 'Atenção: atrasos ou erros leves',
  fail: 'Problema crítico — verificar',
  idle: 'Aguardando dados',
}

const STATUS_LABEL_PT = {
  ok: 'OK',
  warn: 'Atenção',
  fail: 'Falha',
  idle: 'Inativo',
}

// Mini "kpi-like" tile usado dentro do card de cada URL — mais
// compacto que os KPIs globais, para caber 4–8 numa linha só.
function MiniStat({ label, value, sub, color }) {
  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: 'var(--r-md)',
      background: 'var(--bg-3)',
      border: '1px solid var(--line-subtle)',
      minWidth: 0,
    }}>
      <div style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
        {label}
      </div>
      <div className="tnum" style={{
        fontSize: 17,
        fontWeight: 600,
        color: color || 'var(--fg-1)',
        lineHeight: 1.1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 3 }}>{sub}</div>
      )}
    </div>
  )
}

function ForwarderUrlCard({ u }) {
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-subtle)',
      borderRadius: 'var(--r-lg)',
      padding: 16,
      marginBottom: 12,
    }}>
      {/* URL + status */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: '1 1 360px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <StatusIcon status={u.status} size={15} />
            <Pill status={u.status} label={STATUS_LABEL_PT[u.status] || u.status} />
          </div>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--fg-2)',
            wordBreak: 'break-all',
            lineHeight: 1.4,
          }}>
            {u.urlMasked}
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', textAlign: 'right', flexShrink: 0 }}>
          <div>Último OK: <strong className="tnum" style={{ color: 'var(--fg-2)' }}>{u.lastSuccessAgeSec != null ? `há ${formatAge(u.lastSuccessAgeSec)}` : '—'}</strong></div>
          <div style={{ marginTop: 2 }}>Última falha: <strong className="tnum" style={{ color: u.lastFailureAgeSec != null ? 'var(--danger)' : 'var(--fg-2)' }}>{u.lastFailureAgeSec != null ? `há ${formatAge(u.lastFailureAgeSec)}` : '—'}</strong></div>
        </div>
      </div>

      {/* Mini KPIs */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
        gap: 8,
        marginBottom: u.lastError ? 14 : 0,
      }}>
        <MiniStat label="Tentativas" value={u.attemptCount} />
        <MiniStat label="Sucesso" value={u.successCount} color={u.successCount > 0 ? 'var(--success)' : undefined} />
        <MiniStat label="Falhas" value={u.failureCount} color={u.failureCount > 0 ? 'var(--danger)' : undefined} />
        <MiniStat
          label="Taxa falha"
          value={`${(u.failureRate * 100).toFixed(1)}%`}
          color={u.failureRate > 0.05 ? 'var(--warn)' : undefined}
        />
        <MiniStat label="Latência avg" value={u.latencyAvgMs != null ? `${u.latencyAvgMs} ms` : '—'} />
        <MiniStat label="P95" value={u.latencyP95Ms != null ? `${u.latencyP95Ms} ms` : '—'} />
        <MiniStat label="Máx" value={u.latencyMaxMs != null ? `${u.latencyMaxMs} ms` : '—'} />
        <MiniStat label="Último status HTTP" value={u.lastStatus ?? '—'} />
      </div>

      {/* Erro detalhado da URL */}
      {u.lastError && (
        <div style={{
          background: 'var(--danger-soft)',
          border: '1px solid oklch(68% 0.20 25 / 0.3)',
          borderRadius: 'var(--r-md)',
          padding: '10px 12px',
          fontSize: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, color: 'var(--danger)', fontWeight: 600 }}>
            <XCircle size={13} /> Último erro
            {u.lastStatus ? <span style={{ marginLeft: 6, color: 'var(--fg-3)', fontWeight: 500 }}>HTTP {u.lastStatus}</span> : null}
          </div>
          <div style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--fg-1)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.5,
          }}>
            {u.lastError}
          </div>
        </div>
      )}
    </div>
  )
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
  const totalSkipped = (fwd.skippedByEvent || 0) + (fwd.skippedByFromMe || 0)
  const successRate = fwd.totalAttempts > 0 ? (fwd.totalSuccess / fwd.totalAttempts) * 100 : null

  return (
    <div className="page">
      {/* Cabeçalho */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Activity size={20} style={{ color: 'var(--accent)' }} />
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>Controle Webhook</h2>
          </div>
          <div className="card-title-sub" style={{ marginTop: 4 }}>
            Saúde do recebimento, repasse e processamento — polling a cada 5s
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {data && <Pill status={globalStatus} label={GLOBAL_STATUS_LABEL[globalStatus]} big />}
          <button
            className="btn-icon"
            style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={fetchHealth}
            title="Atualizar"
          >
            <RefreshCw size={14} />
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
          {/* KPIs globais */}
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi-head">
                <div className="kpi-label"><Inbox size={13} /><span>Posts recebidos</span></div>
              </div>
              <div className="kpi-value tnum">{diag.webhookPostCount ?? 0}</div>
              <div className="kpi-sub">{lastIngress ? `último há ${formatAge(lastIngress.ageSec)}` : 'nenhum POST ainda'}</div>
            </div>

            <div className="kpi">
              <div className="kpi-head">
                <div className="kpi-label"><Zap size={13} /><span>Último processamento</span></div>
              </div>
              <div className="kpi-value" style={{ fontSize: 15, fontWeight: 600 }}>
                {lastSync ? lastSync.outcome : '—'}
              </div>
              <div className="kpi-sub">
                {lastSync
                  ? `event=${lastSync.event ?? '?'} • há ${formatAge(lastSync.ageSec)}`
                  : 'nunca'}
              </div>
            </div>

            <div className="kpi">
              <div className="kpi-head">
                <div className="kpi-label"><Server size={13} /><span>Último push no buffer</span></div>
              </div>
              <div
                className="kpi-value"
                style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={lastBuffer ? lastBuffer.sessionId : ''}
              >
                {lastBuffer ? lastBuffer.sessionId : '—'}
              </div>
              <div className="kpi-sub">{lastBuffer ? `há ${formatAge(lastBuffer.ageSec)}` : 'nunca'}</div>
            </div>

            <div className="kpi">
              <div className="kpi-head">
                <div className="kpi-label"><Activity size={13} /><span>Scheduler</span></div>
              </div>
              <div className="kpi-value tnum" style={{ color: scheduler.running ? 'var(--success)' : 'var(--danger)' }}>
                {scheduler.running ? 'ON' : 'OFF'}
              </div>
              <div className="kpi-sub">
                intervalo {scheduler.intervalSec ?? '?'}s • debounce {scheduler.debounceSec ?? '?'}s
              </div>
            </div>

            <div className="kpi">
              <div className="kpi-head">
                <div className="kpi-label"><Send size={13} /><span>Taxa de sucesso fan-out</span></div>
              </div>
              <div className="kpi-value tnum" style={{
                color: successRate == null ? 'var(--fg-2)' : successRate >= 95 ? 'var(--success)' : successRate >= 80 ? 'var(--warn)' : 'var(--danger)',
              }}>
                {successRate == null ? '—' : `${successRate.toFixed(1)}%`}
              </div>
              <div className="kpi-sub">
                {fwd.totalAttempts > 0
                  ? `${fwd.totalSuccess}/${fwd.totalAttempts} ok • ${fwd.totalFailure} falha${fwd.totalFailure === 1 ? '' : 's'}`
                  : 'aguardando tráfego'}
              </div>
            </div>
          </div>

          {/* Card: Fan-out */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <div className="card-title">
                <Send size={15} style={{ color: 'var(--accent)' }} />
                Repasse para n8n (fan-out)
                <span className="card-title-sub">
                  {fwd.enabled ? `${fwd.configuredCount} URL${fwd.configuredCount === 1 ? '' : 's'} configurada${fwd.configuredCount === 1 ? '' : 's'}` : 'desligado'}
                </span>
              </div>
              {fwd.enabled && totalSkipped > 0 && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11.5,
                  color: 'var(--fg-3)',
                }} title="Payloads ignorados pelo filtro de evento/fromMe">
                  <Filter size={12} />
                  Filtrados: <strong className="tnum" style={{ color: 'var(--fg-2)' }}>{totalSkipped}</strong>
                  <span style={{ marginLeft: 4 }}>(evento {fwd.skippedByEvent || 0} · fromMe {fwd.skippedByFromMe || 0})</span>
                </div>
              )}
            </div>
            <div className="card-body">
              {(!fwd.enabled || fwd.configuredCount === 0) ? (
                <div className="empty">
                  Fan-out desligado — configure <code>EVOLUTION_WEBHOOK_FORWARD_URL</code> no .env e reinicie o serviço.
                </div>
              ) : (
                <>
                  {(fwd.urls || []).map((u, i) => (
                    <ForwarderUrlCard key={i} u={u} />
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Erro async recente do handler do webhook */}
          {lastAsyncError && lastAsyncError.ageSec < 1800 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header">
                <div className="card-title" style={{ color: 'var(--danger)' }}>
                  <XCircle size={15} />
                  Erro recente no processamento
                  <span className="card-title-sub">há {formatAge(lastAsyncError.ageSec)}</span>
                </div>
              </div>
              <div className="card-body">
                <div style={{ display: 'grid', gap: 6, fontSize: 12.5 }}>
                  <div><span style={{ color: 'var(--fg-3)' }}>Origem:</span> <code style={{ fontFamily: 'var(--font-mono)' }}>{lastAsyncError.where}</code></div>
                  <div style={{
                    background: 'var(--danger-soft)',
                    border: '1px solid oklch(68% 0.20 25 / 0.3)',
                    borderRadius: 'var(--r-md)',
                    padding: '10px 12px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--fg-1)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    lineHeight: 1.5,
                  }}>
                    {lastAsyncError.message}
                  </div>
                </div>
              </div>
            </div>
          )}

          {lastFetchAt && (
            <div style={{ fontSize: 11.5, color: 'var(--fg-3)', textAlign: 'right' }}>
              Atualizado às {new Date(lastFetchAt).toLocaleTimeString('pt-BR')}
            </div>
          )}
        </>
      )}
    </div>
  )
}
