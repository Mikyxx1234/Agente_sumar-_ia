import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Filter, RefreshCw, Activity, Users, Inbox, Clock,
  CheckCircle2, AlertCircle, Phone, Zap, PlayCircle, Search,
  Globe, ExternalLink,
} from 'lucide-react'
import KommoLeadLink from './KommoLeadLink'

function formatAge(sec) {
  if (sec == null) return '—'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  if (sec < 86400) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return `${h}h ${m}m`
  }
  return `${Math.floor(sec / 86400)}d`
}

function FilterChip({ active, onClick, children }) {
  return (
    <button type="button" className={`exec-filter-chip${active ? ' active' : ''}`} onClick={onClick}>
      {children}
    </button>
  )
}

function ConfigStatus({ config }) {
  const enabled = config.enabled && config.running
  const pipelineOk = Boolean(config.pipelineId && config.statusId)
  const items = [
    {
      label: 'Scheduler',
      value: config.running ? 'ON' : 'OFF',
      tone: config.running ? 'success' : 'danger',
      sub: `intervalo ${config.intervalSec}s · debounce ${config.debounceSec}s`,
    },
    {
      label: 'Pipeline',
      value: config.pipelineId ?? '—',
      tone: config.pipelineId ? 'info' : 'danger',
      sub: config.pipelineId ? 'KOMMO_AGENT_PIPELINE_ID' : 'não configurado',
    },
    {
      label: 'Status',
      value: config.statusId ?? '—',
      tone: config.statusId ? 'info' : 'danger',
      sub: config.statusId ? 'KOMMO_AGENT_STATUS_ID' : 'não configurado',
    },
    {
      label: 'Orphan flush',
      value: config.orphanFlush ? 'ON' : 'OFF',
      tone: config.orphanFlush ? 'success' : 'muted',
      sub: 'webhook sem funil',
    },
    {
      label: 'Whitelist teste',
      value: config.whitelist?.length ? `${config.whitelist.length} lead(s)` : '—',
      tone: config.whitelist?.length ? 'warn' : 'muted',
      sub: config.whitelist?.length ? config.whitelist.slice(0, 4).join(', ') : 'KOMMO_AGENT_TEST_LEAD_IDS vazio',
    },
  ]
  return (
    <>
      <div className="kpi-grid">
        {items.map((it) => (
          <div className="kpi" key={it.label}>
            <div className="kpi-head">
              <div className="kpi-label"><Activity size={13} /><span>{it.label}</span></div>
            </div>
            <div
              className="kpi-value tnum"
              style={{
                fontSize: 18,
                color:
                  it.tone === 'success' ? 'var(--success)' :
                  it.tone === 'danger' ? 'var(--danger)' :
                  it.tone === 'warn' ? 'var(--warn)' :
                  it.tone === 'info' ? 'var(--accent-fg)' : 'var(--fg-1)',
              }}
            >
              {it.value}
            </div>
            <div className="kpi-sub" title={it.sub}>{it.sub}</div>
          </div>
        ))}
      </div>
      {(!pipelineOk || !config.publicWebhookBaseUrl) && (
        <div className="mat-info-banner" style={{ marginBottom: 14 }}>
          <AlertCircle size={16} />
          <div>
            {!pipelineOk && (
              <div>
                Defina <code>KOMMO_AGENT_PIPELINE_ID</code> e <code>KOMMO_AGENT_STATUS_ID</code> no <code>.env</code> e reinicie o servidor.
                Sem isso o scheduler não escolhe quem responder.
              </div>
            )}
            {!config.publicWebhookBaseUrl && (
              <div style={{ marginTop: pipelineOk ? 0 : 6 }}>
                <code>PUBLIC_WEBHOOK_BASE_URL</code> não configurado — em produção isso quebra mídia e re-callbacks.
              </div>
            )}
          </div>
        </div>
      )}
      {enabled && pipelineOk && (
        <div className="mat-info-banner mat-info-banner--ok" style={{ marginBottom: 14 }}>
          <Globe size={16} />
          <div>
            Scheduler ativo em pipeline <strong>{config.pipelineId}</strong> · status <strong>{config.statusId}</strong>.
            Tick a cada {config.intervalSec}s, debounce {config.debounceSec}s.
            {config.publicWebhookBaseUrl && (
              <> Webhook público: <code>{config.publicWebhookBaseUrl}</code></>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function LeadRow({ row, selected, onSelect }) {
  const eligible = row.eligibleNow
  const hasBuffer = row.bufferCount > 0
  return (
    <div
      className={`exec-item${selected ? ' selected' : ''}`}
      onClick={() => onSelect(row)}
    >
      <div className="exec-item-head">
        <span className="exec-item-id" style={{ fontWeight: 600 }}>
          {row.contactName || row.leadName || `Lead ${row.leadId}`}
        </span>
        <span className="exec-item-badges">
          {eligible && <span className="badge success" style={{ fontSize: 10 }}>elegível</span>}
          {hasBuffer && !eligible && <span className="badge warn" style={{ fontSize: 10 }}>aguardando</span>}
          {!hasBuffer && <span className="badge" style={{ fontSize: 10 }}>sem msg</span>}
          {!row.inWhitelist && <span className="badge danger" style={{ fontSize: 10 }}>fora whitelist</span>}
        </span>
      </div>
      <div className="exec-item-msg">
        {row.phone ? (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{row.phone}</span>
        ) : (
          <span style={{ color: 'var(--danger)' }}>sem telefone</span>
        )}
        {' · '}
        <span style={{ color: 'var(--fg-3)' }}>buffer: {row.bufferCount}</span>
      </div>
      <div className="exec-item-footer tnum">
        <span><Clock size={10} /> {row.lastTouchedAt ? `há ${formatAge(row.ageSec)}` : 'sem atividade'}</span>
        <span style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <KommoLeadLink leadId={row.leadId} studentName={row.contactName || row.leadName} size="sm" />
        </span>
      </div>
    </div>
  )
}

function OrphanRow({ row, onCopySession }) {
  return (
    <div className="exec-item" style={{ cursor: 'default' }}>
      <div className="exec-item-head">
        <span className="exec-item-id" style={{ fontWeight: 600 }}>
          <Phone size={12} />
          {row.sessionId.replace('@s.whatsapp.net', '')}
        </span>
        <span className="badge warn" style={{ fontSize: 10 }}>órfão</span>
      </div>
      <div className="exec-item-msg" title={row.preview}>
        {row.preview || '(sem texto)'}
      </div>
      <div className="exec-item-footer tnum">
        <span><Inbox size={10} /> {row.bufferCount} msg</span>
        <span><Clock size={10} /> {row.lastTouchedAt ? `há ${formatAge(row.ageSec)}` : 'sem ts'}</span>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ height: 22, padding: '0 8px', fontSize: 11, marginLeft: 'auto' }}
          onClick={() => onCopySession(row.sessionId)}
        >
          Copiar sessão
        </button>
      </div>
    </div>
  )
}

function LeadDetail({ row, kommoBaseUrl }) {
  const eligible = row.eligibleNow
  return (
    <div className="exec-detail">
      <div className="exec-detail-header">
        <div className="exec-detail-id-row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 className="mat-detail-title">{row.contactName || row.leadName || `Lead ${row.leadId}`}</h2>
          {eligible
            ? <span className="badge success">Elegível agora</span>
            : row.bufferCount > 0
              ? <span className="badge warn">Aguardando debounce</span>
              : <span className="badge">Sem mensagens no buffer</span>
          }
          {!row.inWhitelist && (
            <span className="badge danger">Fora da whitelist de teste</span>
          )}
          <KommoLeadLink leadId={row.leadId} studentName={row.contactName || row.leadName} size="md" />
        </div>
        <div className="exec-detail-meta">
          <span><Users size={12} /> lead {row.leadId}</span>
          {row.pipelineId && <span>pipeline {row.pipelineId}</span>}
          {row.statusId && <span>status {row.statusId}</span>}
        </div>
      </div>

      <div className="mat-data-grid">
        <div className="mat-data-field">
          <span className="mat-data-label"><Phone size={12} /> Telefone</span>
          <span className="mat-data-value">{row.phone || '—'}</span>
        </div>
        <div className="mat-data-field">
          <span className="mat-data-label"><Activity size={12} /> Session ID</span>
          <span className="mat-data-value" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {row.sessionId || '—'}
          </span>
        </div>
        <div className="mat-data-field">
          <span className="mat-data-label"><Inbox size={12} /> Mensagens no buffer</span>
          <span className="mat-data-value">{row.bufferCount}</span>
        </div>
        <div className="mat-data-field">
          <span className="mat-data-label"><Clock size={12} /> Última atividade</span>
          <span className="mat-data-value">
            {row.lastTouchedAt
              ? `há ${formatAge(row.ageSec)} (${new Date(row.lastTouchedAt).toLocaleString('pt-BR')})`
              : '—'}
          </span>
        </div>
      </div>

      {!row.phone && (
        <p className="mat-hint-line" style={{ color: 'var(--danger)' }}>
          Lead sem telefone — o scheduler não consegue montar o sessionId WhatsApp.
          Preencha o campo de telefone no Kommo (contato ou lead) para o agente responder.
        </p>
      )}

      {row.bufferCount === 0 && row.phone && (
        <p className="mat-hint-line">
          Nenhuma mensagem pendente para esta sessão. O próximo tick só processa este lead
          quando entrarem mensagens novas via webhook Evolution (ou poll Kommo).
        </p>
      )}

      {kommoBaseUrl && (
        <p className="mat-hint-line" style={{ marginTop: 12 }}>
          <a
            href={`${kommoBaseUrl.replace(/\/$/, '')}/leads/detail/${row.leadId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="kommo-lead-link kommo-lead-link--md"
          >
            <ExternalLink size={14} /> Abrir lead no Kommo
          </a>
        </p>
      )}
    </div>
  )
}

export default function FunilKommo() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState(null)
  const [tab, setTab] = useState('leads')
  const [search, setSearch] = useState('')
  const [eligibleOnly, setEligibleOnly] = useState(false)
  const [whitelistOnly, setWhitelistOnly] = useState(false)
  const [toast, setToast] = useState(null)
  const [ticking, setTicking] = useState(false)

  const fetchFunnel = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true)
    try {
      const r = await fetch('/api/scheduler/funnel')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      setData(j)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      if (!silent) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchFunnel()
    const id = setInterval(() => fetchFunnel(true), 10000)
    return () => clearInterval(id)
  }, [fetchFunnel])

  useEffect(() => {
    if (!selected || !data) return
    const next = (data.leads || []).find((l) => l.leadId === selected.leadId)
    if (next && next !== selected) setSelected(next)
  }, [data, selected])

  const onTickNow = async () => {
    setTicking(true)
    try {
      const r = await fetch('/api/scheduler/tick', { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      setToast(j.ok
        ? `Tick disparado: ${j.stats?.processed ?? 0} processados, ${j.stats?.skippedDebounce ?? 0} em debounce`
        : `Falha no tick: ${j.error || 'desconhecido'}`)
    } catch (e) {
      setToast(`Erro tick: ${e.message}`)
    } finally {
      setTicking(false)
      setTimeout(() => setToast(null), 3500)
      fetchFunnel(true)
    }
  }

  const onCopySession = (sid) => {
    if (!sid) return
    navigator.clipboard?.writeText(sid).then(() => {
      setToast(`Session copiada: ${sid}`)
      setTimeout(() => setToast(null), 2500)
    })
  }

  const filteredLeads = useMemo(() => {
    let list = data?.leads || []
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter((l) =>
        [l.leadId, l.leadName, l.contactName, l.phone, l.sessionId]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      )
    }
    if (eligibleOnly) list = list.filter((l) => l.eligibleNow)
    if (whitelistOnly && data?.config?.whitelist?.length) list = list.filter((l) => l.inWhitelist)
    return list
  }, [data, search, eligibleOnly, whitelistOnly])

  const orphans = data?.orphans || []
  const config = data?.config || {}

  const eligibleCount = (data?.leads || []).filter((l) => l.eligibleNow).length
  const withBufferCount = (data?.leads || []).filter((l) => l.bufferCount > 0).length

  return (
    <div className="exec-viewer mat-viewer">
      <div className="pg-header">
        <div className="pg-title-group">
          <h1 className="page-title" style={{ fontSize: 18 }}>Funil Kommo</h1>
          {data && (
            <span className="badge">
              {(data.leads || []).length} lead{(data.leads || []).length === 1 ? '' : 's'} · {eligibleCount} elegíveis
            </span>
          )}
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onTickNow}
            disabled={ticking || !config.enabled}
            title={!config.enabled ? 'Scheduler desligado' : 'Dispara um tick imediato'}
          >
            <PlayCircle size={14} /> <span>{ticking ? 'Disparando…' : 'Disparar tick'}</span>
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => fetchFunnel()} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> <span>Atualizar</span>
          </button>
        </div>
      </div>

      <div className="page" style={{ padding: '16px 24px 8px' }}>
        {loading && !data && (
          <div className="state-msg" style={{ height: 200 }}>
            <div className="loader" />
            <p>Carregando funil…</p>
          </div>
        )}
        {error && (
          <div className="mat-info-banner">
            <AlertCircle size={16} /> Erro ao carregar: {error}
          </div>
        )}
        {data?.hint && (
          <div className="mat-info-banner">
            <AlertCircle size={16} /> {data.hint}
          </div>
        )}
        {data?.kommoError && (
          <div className="mat-info-banner">
            <AlertCircle size={16} /> Kommo respondeu erro: {String(data.kommoError)}
          </div>
        )}
        {data && <ConfigStatus config={config} />}
      </div>

      <div className="prompts-toolbar" style={{ padding: '0 24px', marginBottom: 8 }}>
        <div className="filter-chips">
          <button
            type="button"
            className={`chip${tab === 'leads' ? ' active' : ''}`}
            onClick={() => setTab('leads')}
          >
            Leads no funil <span className="chip-count">{(data?.leads || []).length}</span>
          </button>
          <button
            type="button"
            className={`chip${tab === 'orphans' ? ' active' : ''}`}
            onClick={() => setTab('orphans')}
          >
            Órfãos (buffer sem lead) <span className="chip-count">{orphans.length}</span>
          </button>
        </div>
      </div>

      <div className="exec-layout">
        <div className="exec-list-panel">
          <div className="exec-list-head">
            {tab === 'leads' && (
              <>
                <div className="search-wrap">
                  <Search size={14} className="search-icon" />
                  <input
                    className="input"
                    placeholder="Buscar nome, telefone, lead…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="exec-filters">
                  <div className="exec-filter-row">
                    <span className="exec-filter-group-label">Mostrar</span>
                    <FilterChip active={!eligibleOnly && !whitelistOnly} onClick={() => { setEligibleOnly(false); setWhitelistOnly(false) }}>
                      Todos ({(data?.leads || []).length})
                    </FilterChip>
                    <FilterChip active={eligibleOnly} onClick={() => setEligibleOnly((v) => !v)}>
                      Elegíveis ({eligibleCount})
                    </FilterChip>
                    <FilterChip active={whitelistOnly} onClick={() => setWhitelistOnly((v) => !v)}>
                      Em whitelist
                    </FilterChip>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    {withBufferCount} lead(s) com buffer, {eligibleCount} prontos no próximo tick.
                  </div>
                </div>
              </>
            )}
            {tab === 'orphans' && (
              <div style={{ fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.5 }}>
                Sessões com mensagens no buffer mas <strong>sem lead correspondente</strong> no funil/status configurados.
                Se <code>KOMMO_SCHEDULER_WEBHOOK_ORPHAN_FLUSH</code> estiver ligado, o scheduler ainda processa.
              </div>
            )}
          </div>
          <div className="exec-list-items">
            {tab === 'leads' && (
              <>
                {filteredLeads.length === 0 && !loading && (
                  <div className="empty">
                    <Filter size={28} className="empty-icon" />
                    <div className="empty-title">Nenhum lead no funil</div>
                    <div style={{ fontSize: 12, maxWidth: 280, margin: '0 auto', lineHeight: 1.45 }}>
                      Quando um lead entrar no pipeline/status configurados, ele aparece aqui com o estado do buffer.
                    </div>
                  </div>
                )}
                {filteredLeads.map((row) => (
                  <LeadRow
                    key={row.leadId}
                    row={row}
                    selected={selected?.leadId === row.leadId}
                    onSelect={(r) => setSelected(r)}
                  />
                ))}
              </>
            )}
            {tab === 'orphans' && (
              <>
                {orphans.length === 0 && (
                  <div className="empty">
                    <CheckCircle2 size={28} className="empty-icon" />
                    <div className="empty-title">Sem sessões órfãs</div>
                    <div style={{ fontSize: 12, maxWidth: 260, margin: '0 auto', lineHeight: 1.45 }}>
                      Todo buffer pendente está associado a um lead do funil.
                    </div>
                  </div>
                )}
                {orphans.map((o) => (
                  <OrphanRow key={o.sessionId} row={o} onCopySession={onCopySession} />
                ))}
              </>
            )}
          </div>
        </div>

        <div className="exec-detail-panel">
          {tab === 'leads' && selected ? (
            <LeadDetail row={selected} kommoBaseUrl={config.kommoBaseUrl} />
          ) : (
            <div className="exec-detail-empty">
              <div>
                <div className="empty-icon"><Zap size={24} /></div>
                <div style={{ color: 'var(--fg-2)', fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
                  {tab === 'orphans' ? 'Selecione um lead na aba Leads' : 'Selecione um lead'}
                </div>
                <div style={{ fontSize: 12 }}>Veja buffer, telefone, idade da última msg e link Kommo</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="toast"><CheckCircle2 size={14} className="toast-check" />{toast}</div>
      )}
    </div>
  )
}
