import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  Search, Clock, Bot, Database, ChevronRight, ChevronDown,
  AlertCircle, Cpu, Zap, Copy, RefreshCw, Check, Bot as BotIcon,
  Wand2, FileSearch, Tag, GraduationCap, BookMarked,
} from 'lucide-react'
import { getAllSalesbotExecutions, runSalesbotForLead, reindexPosEmbeddings, probePosCurso } from '../lib/salesbotStore'

function formatDuration(ms) {
  if (!ms || ms < 1000) return `${ms || 0}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function FlowStep({ icon: Icon, iconKind, title, duration, headerBadge, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const hasContent = !!children
  return (
    <div className="flow-step">
      <div className={`flow-indicator ${iconKind || ''}`}>
        <Icon size={14} />
      </div>
      <div className="flow-card">
        <div className="flow-card-head" onClick={() => hasContent && setOpen(!open)}>
          <div className="flow-card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>{title}</span>
            {headerBadge}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {duration != null && (
              <span className="flow-card-duration">
                <Clock size={10} /> {formatDuration(duration)}
              </span>
            )}
            {hasContent && (open ? <ChevronDown size={14} style={{ color: 'var(--fg-3)' }} /> : <ChevronRight size={14} style={{ color: 'var(--fg-3)' }} />)}
          </div>
        </div>
        {open && hasContent && <div className="flow-card-body">{children}</div>}
      </div>
    </div>
  )
}

function KvTable({ data }) {
  const entries = data && typeof data === 'object' ? Object.entries(data) : []
  if (!entries.length) return <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>(vazio)</div>
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, max-content) 1fr', gap: '4px 12px', fontSize: 12 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <div style={{ color: 'var(--fg-3)', fontWeight: 500 }}>{k}</div>
          <div style={{ color: 'var(--fg-1)', wordBreak: 'break-word' }}>
            {v == null || v === '' ? <span style={{ color: 'var(--fg-3)' }}>—</span> : String(v)}
          </div>
        </div>
      ))}
    </div>
  )
}

function ExecutionDetail({ execution, onCopy }) {
  const NivelIcon = execution.nivel === 'pos' ? BookMarked : GraduationCap
  return (
    <div className="exec-detail">
      <div className="exec-detail-header">
        <div className="exec-detail-id-row">
          <button className="exec-detail-id" onClick={() => { navigator.clipboard?.writeText(execution.id); onCopy() }}>
            {execution.id}
            <Copy size={13} />
          </button>
          <span className={`badge ${execution.error ? 'danger' : execution.encontrado ? 'success' : 'warning'}`}>
            {execution.error ? 'Erro' : execution.encontrado ? 'Encontrado' : 'Não encontrado'}
          </span>
          <span className="badge" style={{ background: execution.nivel === 'pos' ? 'var(--accent, #3b82f6)' : 'var(--bg-3, rgba(255,255,255,0.08))', color: execution.nivel === 'pos' ? '#fff' : 'var(--fg-2)' }}>
            <NivelIcon size={11} style={{ marginRight: 4, marginBottom: -1 }} />
            {execution.nivel === 'pos' ? 'Pós-graduação' : 'Graduação'}
          </span>
        </div>
        <div className="exec-detail-meta">
          <span><Clock size={12} /> {formatTime(execution.timestamp)}</span>
          {execution.model && <span><Cpu size={12} /> {execution.model}</span>}
          <span><Zap size={12} /> {formatDuration(execution.durationMs)}</span>
          {execution.leadId && <span><Tag size={12} /> Lead {execution.leadId}</span>}
        </div>
      </div>
      <div className="flow-track">
        <FlowStep icon={Database} iconKind="info" title="Lead Kommo" defaultOpen>
          <KvTable
            data={{
              id_lead: execution.leadId,
              curso_original: execution.cursoOriginal,
              grau_original: execution.grauOriginal,
            }}
          />
        </FlowStep>
        <FlowStep
          icon={BotIcon}
          iconKind="info"
          title={`Agente IA · ${execution.model || 'gpt-4.1-mini'}`}
          defaultOpen
          headerBadge={
            execution.cursoCorrigido && (
              <span style={{ fontSize: 11, color: 'var(--accent, #3b82f6)' }}>
                → {execution.cursoCorrigido}
              </span>
            )
          }
        >
          <KvTable
            data={{
              entrada: execution.cursoOriginal,
              corrigido: execution.cursoCorrigido,
              query_supabase: execution.cursoBusca,
            }}
          />
          {execution.aiMeta?.toolCalls?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>
                Tool calls do agente:
              </div>
              {execution.aiMeta.toolCalls.map((tc, idx) => (
                <div key={idx} style={{ padding: '6px 8px', borderLeft: '3px solid var(--accent)', background: 'var(--bg-2, rgba(255,255,255,0.02))', marginTop: 4, fontSize: 11 }}>
                  <div style={{ fontWeight: 600 }}>{tc.tool} ({JSON.stringify(tc.args)})</div>
                  <div style={{ color: 'var(--fg-2)', whiteSpace: 'pre-wrap', marginTop: 2 }}>
                    {(tc.result || '').slice(0, 400)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </FlowStep>
        <FlowStep
          icon={FileSearch}
          iconKind={execution.encontrado ? 'success' : 'warning'}
          title="SQL · cursos_salesbot"
          defaultOpen={!execution.encontrado}
          headerBadge={
            <span
              style={{
                fontSize: 11,
                color: execution.encontrado ? 'var(--success, #10b981)' : 'var(--warning, #f59e0b)',
              }}
            >
              {execution.encontrado ? 'linha encontrada' : 'sem match'}
            </span>
          }
        >
          {execution.rowCurso ? (
            <KvTable data={execution.rowCurso} />
          ) : (
            <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>
              Nenhuma linha em <code>cursos_salesbot</code> casou com a query{' '}
              <code>{execution.cursoBusca || '(vazio)'}</code>. O lead foi marcado como{' '}
              <code>Não Encontrado</code>.
            </div>
          )}
        </FlowStep>
        <FlowStep
          icon={Database}
          iconKind={execution.error ? 'error' : 'success'}
          title="PATCH no Kommo"
          defaultOpen={!!execution.error}
        >
          {execution.error ? (
            <div className="flow-content-text" style={{ color: 'var(--danger)' }}>
              {execution.error}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              {execution.encontrado
                ? 'Lead atualizado com 14 campos da linha encontrada (Curso, Grau, Modalidade, Semestres, Preços, Tipo, Contagem).'
                : 'Lead atualizado com Curso = "Não Encontrado".'}
            </div>
          )}
        </FlowStep>
        {execution.steps?.length > 0 && (
          <FlowStep icon={Wand2} iconKind="info" title="Steps (debug)" defaultOpen={false}>
            <pre
              style={{
                fontSize: 11,
                maxHeight: 240,
                overflow: 'auto',
                background: 'var(--bg-2, rgba(255,255,255,0.02))',
                padding: 8,
                borderRadius: 4,
              }}
            >
              {JSON.stringify(execution.steps, null, 2)}
            </pre>
          </FlowStep>
        )}
      </div>
    </div>
  )
}

export default function SalesbotExecutions() {
  const [executions, setExecutions] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all') // all | encontrado | nao_encontrado | erro
  const [selectedId, setSelectedId] = useState(null)
  const [copiedFlash, setCopiedFlash] = useState(false)
  const [manualLeadId, setManualLeadId] = useState('')
  const [running, setRunning] = useState(false)
  const [nivelFilter, setNivelFilter] = useState('all') // all | grad | pos
  const [reindexing, setReindexing] = useState(false)
  const [reindexResult, setReindexResult] = useState(null)
  const [probeQuery, setProbeQuery] = useState('')
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const rows = await getAllSalesbotExecutions(300)
    setExecutions(rows)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return executions.filter((e) => {
      if (filter === 'encontrado' && !e.encontrado) return false
      if (filter === 'nao_encontrado' && (e.encontrado || e.error)) return false
      if (filter === 'erro' && !e.error) return false
      if (nivelFilter === 'grad' && e.nivel === 'pos') return false
      if (nivelFilter === 'pos' && e.nivel !== 'pos') return false
      if (q) {
        const hay = `${e.id} ${e.leadId} ${e.cursoOriginal} ${e.cursoCorrigido} ${e.cursoBusca} ${e.error || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [executions, search, filter, nivelFilter])

  const selected = useMemo(
    () => executions.find((e) => e.id === selectedId) || filtered[0] || null,
    [executions, filtered, selectedId],
  )

  const onCopy = () => {
    setCopiedFlash(true)
    setTimeout(() => setCopiedFlash(false), 1500)
  }

  const onRunManual = async () => {
    const id = Number(manualLeadId)
    if (!Number.isFinite(id) || id <= 0) return
    setRunning(true)
    await runSalesbotForLead(id)
    setRunning(false)
    setManualLeadId('')
    refresh()
  }

  const onReindexPos = async (opts = {}) => {
    const force = opts.force === true
    const msg = force
      ? 'FORÇA a regeneração de TODOS os embeddings pós (~$0.01, 30-60s). Use depois de mudar a normalização do texto. Confirma?'
      : 'Gera embeddings dos cursos pós que ainda não têm (linhas novas/sinônimos). Demora uns segundos. Confirma?'
    if (!confirm(msg)) return
    setReindexing(true)
    setReindexResult(null)
    try {
      const r = await reindexPosEmbeddings({ force })
      setReindexResult(r)
    } catch (e) {
      setReindexResult({ ok: false, error: e?.message || 'falhou' })
    } finally {
      setReindexing(false)
    }
  }

  const onProbe = async () => {
    const q = probeQuery.trim()
    if (!q) return
    setProbing(true)
    setProbeResult(null)
    try {
      const r = await probePosCurso(q, 5)
      setProbeResult(r)
    } catch (e) {
      setProbeResult({ ok: false, error: e?.message || 'falhou' })
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1>Execuções Salesbot</h1>
          <p style={{ color: 'var(--fg-3)', fontSize: 13, marginTop: 4 }}>
            Pesquisa de curso disparada por webhook do Kommo
            (<code>POST /api/salesbot/webhook</code> ou <code>POST /webhook/robocsv</code>)
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn-secondary"
            onClick={() => onReindexPos({ force: false })}
            disabled={reindexing}
            title="Gera embedding só das linhas novas (embedding NULL). Use depois de inserir sinônimos via SQL."
          >
            <BookMarked size={14} /> {reindexing ? 'Indexando…' : 'Reindexar pós (novos)'}
          </button>
          <button
            className="btn-secondary"
            onClick={() => onReindexPos({ force: true })}
            disabled={reindexing}
            title="FORÇA reindex de TODAS as linhas. Use quando mudar a normalização do texto (lowercase/sem acento)."
          >
            <BookMarked size={14} /> {reindexing ? 'Forçando…' : 'Reindexar tudo (forçar)'}
          </button>
          <button className="btn-secondary" onClick={refresh} disabled={loading}>
            <RefreshCw size={14} /> {loading ? 'Atualizando…' : 'Atualizar'}
          </button>
        </div>
      </div>

      {reindexResult && (
        <div
          style={{
            padding: '10px 14px',
            background: reindexResult.ok ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${reindexResult.ok ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)'}`,
            borderRadius: 6,
            marginBottom: 14,
            fontSize: 13,
            color: 'var(--fg-1)',
          }}
        >
          {reindexResult.ok ? (
            <>
              ✓ Embeddings OK — {reindexResult.total} cursos pós · {reindexResult.batches} batches ·{' '}
              {((reindexResult.durationMs || 0) / 1000).toFixed(1)}s ·{' '}
              {reindexResult.usage?.total_tokens || 0} tokens
            </>
          ) : (
            <>✗ Erro: {reindexResult.error || 'falha desconhecida'}</>
          )}
        </div>
      )}

      {/* Disparo manual */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          background: 'var(--bg-2, rgba(255,255,255,0.03))',
          border: '1px solid var(--border-1, rgba(255,255,255,0.06))',
          borderRadius: 6,
          marginBottom: 16,
        }}
      >
        <span style={{ fontSize: 13, color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>
          Testar manual:
        </span>
        <input
          type="number"
          placeholder="id_lead Kommo (ex: 19884275)"
          value={manualLeadId}
          onChange={(e) => setManualLeadId(e.target.value)}
          style={{
            flex: 1,
            padding: '6px 10px',
            background: 'var(--bg-1)',
            border: '1px solid var(--border-1)',
            borderRadius: 4,
            color: 'var(--fg-1)',
            fontSize: 13,
          }}
          disabled={running}
        />
        <button className="btn-primary" onClick={onRunManual} disabled={running || !manualLeadId}>
          {running ? 'Executando…' : 'Disparar'}
        </button>
      </div>

      {/* Probe curso pós (read-only) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          background: 'var(--bg-2, rgba(255,255,255,0.03))',
          border: '1px solid var(--border-1, rgba(255,255,255,0.06))',
          borderRadius: 6,
          marginBottom: 16,
        }}
      >
        <span style={{ fontSize: 13, color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>
          Testar curso pós:
        </span>
        <input
          type="text"
          placeholder="ex: Gestão de Recursos Humanos, RH, MBA Finanças…"
          value={probeQuery}
          onChange={(e) => setProbeQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !probing && probeQuery.trim()) onProbe() }}
          style={{
            flex: 1,
            padding: '6px 10px',
            background: 'var(--bg-1)',
            border: '1px solid var(--border-1)',
            borderRadius: 4,
            color: 'var(--fg-1)',
            fontSize: 13,
          }}
          disabled={probing}
        />
        <button className="btn-primary" onClick={onProbe} disabled={probing || !probeQuery.trim()}>
          {probing ? 'Buscando…' : 'Testar'}
        </button>
      </div>

      {probeResult && (
        <div
          style={{
            padding: '10px 14px',
            background: probeResult.httpOk
              ? 'rgba(34,197,94,0.08)'
              : 'rgba(239,68,68,0.08)',
            border: `1px solid ${probeResult.httpOk ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 12,
            color: 'var(--fg-1)',
          }}
        >
          {probeResult.httpOk && probeResult.ok ? (
            <>
              <div style={{ marginBottom: 6 }}>
                <strong>Query:</strong> {probeResult.query} · threshold: {probeResult.threshold ?? '—'} · {probeResult.durationMs}ms
              </div>
              {Array.isArray(probeResult.results) && probeResult.results.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--fg-3)', textAlign: 'left' }}>
                      <th style={{ padding: '4px 6px' }}>#</th>
                      <th style={{ padding: '4px 6px' }}>similarity</th>
                      <th style={{ padding: '4px 6px' }}>curso</th>
                      <th style={{ padding: '4px 6px' }}>durações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {probeResult.results.map((row, idx) => {
                      const threshold = probeResult.threshold ?? 0.7
                      const passa = (row.similarity ?? 0) >= threshold
                      return (
                        <tr
                          key={idx}
                          style={{
                            borderTop: '1px solid var(--border-1, rgba(255,255,255,0.06))',
                            background: passa ? 'rgba(34,197,94,0.06)' : 'transparent',
                          }}
                        >
                          <td style={{ padding: '4px 6px' }}>
                            {passa ? '✓' : idx + 1}
                          </td>
                          <td style={{ padding: '4px 6px', fontFamily: 'monospace' }}>
                            {Number(row.similarity || 0).toFixed(4)}
                          </td>
                          <td style={{ padding: '4px 6px' }}>{row.curso || '—'}</td>
                          <td style={{ padding: '4px 6px', color: 'var(--fg-3)' }}>
                            {[row.duracao_1, row.duracao_2].filter(Boolean).join(' / ') || '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <div>Nenhum resultado.</div>
              )}
            </>
          ) : (
            <>✗ Erro: {probeResult.error || 'falha desconhecida'}</>
          )}
        </div>
      )}

      {/* Busca + filtros */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 240 }}>
          <Search
            size={14}
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-3)' }}
          />
          <input
            type="text"
            placeholder="Buscar por id, lead, curso ou erro…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 10px 8px 32px',
              background: 'var(--bg-2)',
              border: '1px solid var(--border-1)',
              borderRadius: 4,
              color: 'var(--fg-1)',
              fontSize: 13,
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { id: 'all', label: 'Todas' },
            { id: 'encontrado', label: 'Encontrado' },
            { id: 'nao_encontrado', label: 'Não encontrado' },
            { id: 'erro', label: 'Erro' },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={filter === f.id ? 'btn-primary' : 'btn-secondary'}
              style={{ fontSize: 12, padding: '6px 12px' }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
          {[
            { id: 'all', label: 'Todos' },
            { id: 'grad', label: 'Grad' },
            { id: 'pos', label: 'Pós' },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setNivelFilter(f.id)}
              className={nivelFilter === f.id ? 'btn-primary' : 'btn-secondary'}
              style={{ fontSize: 12, padding: '6px 12px' }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {copiedFlash && (
        <div style={{ position: 'fixed', bottom: 20, right: 20, padding: '8px 14px', background: 'var(--success, #10b981)', color: '#fff', borderRadius: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, zIndex: 1000 }}>
          <Check size={14} /> ID copiado
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16, alignItems: 'start' }}>
        {/* Lista */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '70vh', overflow: 'auto', padding: 2 }}>
          {loading && <div style={{ color: 'var(--fg-3)', fontSize: 13, padding: 20, textAlign: 'center' }}>Carregando…</div>}
          {!loading && filtered.length === 0 && (
            <div style={{ color: 'var(--fg-3)', fontSize: 13, padding: 20, textAlign: 'center' }}>
              Nenhuma execução encontrada.
            </div>
          )}
          {filtered.map((e) => {
            const active = selected?.id === e.id
            const tone = e.error ? 'danger' : e.encontrado ? 'success' : 'warning'
            return (
              <button
                key={e.id}
                onClick={() => setSelectedId(e.id)}
                className="exec-list-item"
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: active ? 'var(--bg-3, rgba(255,255,255,0.06))' : 'var(--bg-2, rgba(255,255,255,0.02))',
                  border: `1px solid ${active ? 'var(--accent, #3b82f6)' : 'var(--border-1, rgba(255,255,255,0.06))'}`,
                  borderRadius: 4,
                  cursor: 'pointer',
                  color: 'var(--fg-1)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--fg-2)' }}>{e.id}</span>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, background: e.nivel === 'pos' ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.05)', color: e.nivel === 'pos' ? 'var(--accent, #3b82f6)' : 'var(--fg-3)' }}>
                      {e.nivel === 'pos' ? 'Pós' : 'Grad'}
                    </span>
                    <span className={`badge ${tone}`} style={{ fontSize: 10 }}>
                      {e.error ? 'Erro' : e.encontrado ? 'OK' : 'Não'}
                    </span>
                  </div>
                </div>
                <div style={{ fontSize: 13, marginTop: 4, color: 'var(--fg-1)' }}>
                  {e.cursoOriginal || '(sem curso)'}
                  {e.cursoCorrigido && e.cursoCorrigido !== e.cursoOriginal && (
                    <span style={{ color: 'var(--fg-3)' }}> → {e.cursoCorrigido}</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2, display: 'flex', gap: 10 }}>
                  <span>{formatTime(e.timestamp)}</span>
                  {e.leadId && <span>lead {e.leadId}</span>}
                  <span>{formatDuration(e.durationMs)}</span>
                </div>
              </button>
            )
          })}
        </div>

        {/* Detalhe */}
        <div>
          {selected ? (
            <ExecutionDetail execution={selected} onCopy={onCopy} />
          ) : (
            <div style={{ color: 'var(--fg-3)', fontSize: 13, padding: 30, textAlign: 'center' }}>
              Selecione uma execução pra ver os detalhes.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
