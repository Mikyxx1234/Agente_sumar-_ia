import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  Search, RefreshCw, Filter, GraduationCap, Clock, User,
  Phone, BookOpen, MapPin, AlertCircle, FileText, Cog,
} from 'lucide-react'
import { getAllMatriculas } from '../lib/matriculasStore'
import KommoLeadLink from './KommoLeadLink'

function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function statusLabel(status) {
  const s = (status || '').toLowerCase()
  if (s === 'concluida' || s === 'concluída' || s === 'ok' || s === 'success') {
    return { label: 'Concluída', kind: 'success' }
  }
  if (s === 'erro' || s === 'error' || s === 'falha') {
    return { label: 'Erro', kind: 'danger' }
  }
  if (s === 'pendente' || s === 'pending') {
    return { label: 'Pendente', kind: 'warn' }
  }
  if (s === 'registro_parcial') {
    return { label: 'Registro parcial', kind: 'muted' }
  }
  return { label: status || '—', kind: 'muted' }
}

function FilterChip({ active, onClick, children }) {
  return (
    <button type="button" className={`exec-filter-chip${active ? ' active' : ''}`} onClick={onClick}>
      {children}
    </button>
  )
}

function DataField({ icon: Icon, label, value }) {
  return (
    <div className="mat-data-field">
      <span className="mat-data-label"><Icon size={12} /> {label}</span>
      <span className="mat-data-value">{value || '—'}</span>
    </div>
  )
}

function MatriculaDetail({ row }) {
  const st = statusLabel(row.status)
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : null

  return (
    <div className="exec-detail mat-detail">
      <div className="exec-detail-header">
        <div className="exec-detail-id-row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 className="mat-detail-title">Matrícula</h2>
          <span className={`badge ${st.kind === 'success' ? 'success' : st.kind === 'danger' ? 'danger' : ''}`}>
            {st.label}
          </span>
          {row.leadId && (
            <KommoLeadLink leadId={row.leadId} studentName={row.nome} size="md" />
          )}
        </div>
        <div className="exec-detail-meta">
          <span><Clock size={12} /> {formatTime(row.createdAt)}</span>
          {row.executionId && (
            <span><FileText size={12} /> Exec. {row.executionId}</span>
          )}
          {row.source && (
            <span className="mat-source-tag">fonte: {row.source}</span>
          )}
        </div>
      </div>

      <div className="mat-data-grid">
        <DataField icon={User} label="Nome" value={row.nome} />
        <DataField icon={Phone} label="Telefone" value={row.telefone} />
        <DataField icon={BookOpen} label="Curso" value={row.curso} />
        <DataField icon={GraduationCap} label="Tipo de ingresso" value={row.tipoIngresso} />
        <DataField icon={MapPin} label="Polo" value={row.polo} />
        <div className="mat-data-field">
          <span className="mat-data-label"><User size={12} /> Lead Kommo</span>
          <span className="mat-data-value">
            {row.leadId ? (
              <KommoLeadLink leadId={row.leadId} studentName={row.nome} size="md" showId />
            ) : '—'}
          </span>
        </div>
      </div>

      {row.erro && (
        <section className="exec-block exec-block--error" style={{ marginTop: 14 }}>
          <header className="exec-block-head">
            <div className="exec-block-icon exec-block-icon--error"><AlertCircle size={16} /></div>
            <h3 className="exec-block-title">Erro na matrícula</h3>
          </header>
          <div className="exec-block-body">
            <p className="exec-block-text" style={{ color: 'var(--danger)' }}>{row.erro}</p>
          </div>
        </section>
      )}

      {row.atendimento && (
        <p className="mat-hint-line">Atendimento: <strong>{row.atendimento}</strong></p>
      )}

      {payload && (
        <section className="exec-block exec-block--auto" style={{ marginTop: 14 }}>
          <header className="exec-block-head">
            <div className="exec-block-icon exec-block-icon--auto"><Cog size={16} /></div>
            <h3 className="exec-block-title">Como foi realizada</h3>
          </header>
          <div className="exec-block-body">
            <pre className="flow-content-pre" style={{ maxHeight: 320 }}>
              {JSON.stringify(payload, null, 2)}
            </pre>
          </div>
        </section>
      )}

      {!row.nome && !row.curso && row.source === 'inscricao_ab' && (
        <p className="mat-hint-line">
          Registro antigo (inscrição iniciada). Dados completos do aluno aparecerão quando a matrícula automática gravar em{' '}
          <code>matriculas_realizadas</code>.
        </p>
      )}
    </div>
  )
}

export default function MatriculasViewer() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [periodFilter, setPeriodFilter] = useState('all')
  const [rows, setRows] = useState([])
  const [meta, setMeta] = useState({ source: null, hint: null, tableReady: false })
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const result = await getAllMatriculas()
    setRows(result.rows || [])
    setMeta({
      source: result.source,
      hint: result.hint,
      tableReady: result.tableReady,
    })
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    let list = rows
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter((r) =>
        [r.nome, r.telefone, r.curso, r.leadId, r.tipoIngresso, r.id, r.executionId]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      )
    }
    if (statusFilter !== 'all') {
      list = list.filter((r) => {
        const s = (r.status || '').toLowerCase()
        if (statusFilter === 'concluida') {
          return s === 'concluida' || s === 'concluída' || s === 'ok' || s === 'success'
        }
        if (statusFilter === 'erro') return s === 'erro' || s === 'error' || s === 'falha'
        if (statusFilter === 'pendente') return s === 'pendente' || s === 'pending' || s === 'registro_parcial'
        return true
      })
    }
    if (periodFilter !== 'all') {
      const now = Date.now()
      const days = periodFilter === '7d' ? 7 : periodFilter === '30d' ? 30 : 0
      if (days > 0) {
        const cut = now - days * 86400000
        list = list.filter((r) => {
          const t = r.createdAt ? new Date(r.createdAt).getTime() : 0
          return t >= cut
        })
      }
    }
    return list
  }, [rows, search, statusFilter, periodFilter])

  const activeFilterCount = [statusFilter, periodFilter].filter((f) => f !== 'all').length

  const clearFilters = () => {
    setSearch('')
    setStatusFilter('all')
    setPeriodFilter('all')
  }

  return (
    <div className="exec-viewer mat-viewer">
      <div className="pg-header">
        <div className="pg-title-group">
          <h1 className="page-title" style={{ fontSize: 18 }}>Matrículas realizadas</h1>
          <span className="badge">{filtered.length} de {rows.length}</span>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={load}>
            <RefreshCw size={14} /> <span>Atualizar</span>
          </button>
        </div>
      </div>

      {meta.hint && (
        <div className={`mat-info-banner${meta.tableReady ? ' mat-info-banner--ok' : ''}`}>
          <GraduationCap size={16} />
          <span>{meta.hint}</span>
        </div>
      )}

      <div className="exec-layout">
        <div className="exec-list-panel">
          <div className="exec-list-head">
            <div className="search-wrap">
              <Search size={14} className="search-icon" />
              <input
                className="input"
                placeholder="Buscar nome, telefone, curso, lead…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="exec-filters">
              <div className="exec-filters-label">
                <Filter size={12} /> Filtros
                {activeFilterCount > 0 && (
                  <button type="button" className="exec-filters-clear" onClick={clearFilters}>
                    Limpar ({activeFilterCount})
                  </button>
                )}
              </div>
              <div className="exec-filter-row">
                <span className="exec-filter-group-label">Status</span>
                <FilterChip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>Todos</FilterChip>
                <FilterChip active={statusFilter === 'concluida'} onClick={() => setStatusFilter('concluida')}>Concluídas</FilterChip>
                <FilterChip active={statusFilter === 'pendente'} onClick={() => setStatusFilter('pendente')}>Pendentes</FilterChip>
                <FilterChip active={statusFilter === 'erro'} onClick={() => setStatusFilter('erro')}>Com erro</FilterChip>
              </div>
              <div className="exec-filter-row">
                <span className="exec-filter-group-label">Período</span>
                <FilterChip active={periodFilter === 'all'} onClick={() => setPeriodFilter('all')}>Tudo</FilterChip>
                <FilterChip active={periodFilter === '7d'} onClick={() => setPeriodFilter('7d')}>7 dias</FilterChip>
                <FilterChip active={periodFilter === '30d'} onClick={() => setPeriodFilter('30d')}>30 dias</FilterChip>
              </div>
            </div>
          </div>
          <div className="exec-list-items">
            {loading && (
              <div className="empty"><div className="loader" style={{ margin: '0 auto' }} /></div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="empty">
                <GraduationCap size={28} className="empty-icon" />
                <div className="empty-title">Nenhuma matrícula</div>
                <div style={{ fontSize: 12, maxWidth: 260, margin: '0 auto', lineHeight: 1.45 }}>
                  Quando o agente concluir matrículas automáticas, elas aparecerão aqui com os dados do aluno e link para o Kommo.
                </div>
              </div>
            )}
            {!loading && filtered.map((row) => {
              const st = statusLabel(row.status)
              return (
                <div
                  key={row.id}
                  className={`exec-item${selected?.id === row.id ? ' selected' : ''}`}
                  onClick={() => setSelected(row)}
                >
                  <div className="exec-item-head">
                    <span className="exec-item-id" style={{ fontWeight: 600 }}>
                      {row.nome || (row.leadId ? `Lead ${row.leadId}` : row.id)}
                    </span>
                    <span className={`badge ${st.kind === 'success' ? 'success' : st.kind === 'danger' ? 'danger' : ''}`} style={{ fontSize: 10 }}>
                      {st.label}
                    </span>
                  </div>
                  <div className="exec-item-msg">
                    {[row.curso, row.tipoIngresso].filter(Boolean).join(' · ') || 'Aguardando dados do aluno'}
                  </div>
                  <div className="exec-item-footer tnum">
                    <span><Clock size={10} /> {formatTime(row.createdAt)}</span>
                    {row.leadId && (
                      <span onClick={(e) => e.stopPropagation()}>
                        <KommoLeadLink
                          leadId={row.leadId}
                          studentName={row.nome}
                          size="sm"
                          showId={!row.nome}
                        />
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="exec-detail-panel">
          {selected ? (
            <MatriculaDetail row={selected} />
          ) : (
            <div className="exec-detail-empty">
              <div>
                <div className="empty-icon"><GraduationCap size={24} /></div>
                <div style={{ color: 'var(--fg-2)', fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
                  Selecione uma matrícula
                </div>
                <div style={{ fontSize: 12 }}>Veja dados do aluno, status e atendimento no Kommo</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
