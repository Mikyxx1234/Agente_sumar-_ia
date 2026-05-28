import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ShieldCheck, RefreshCw, Hourglass, ListChecks, Calendar,
  Search, ChevronRight, ChevronDown, CheckCircle2, AlertTriangle,
  XCircle, Wand2, Bot, Filter, Activity, Star,
  RotateCcw, Trash2,
} from 'lucide-react'
import {
  getStats,
  listEvaluations,
  evaluateNow,
  deleteEvaluation,
  retryEvaluation,
} from '../lib/feedbackIAStore'
import { useScopedLeadIds, leadMatchesScope } from '../lib/funnelScope'
import KommoLeadLink from './KommoLeadLink'
import FeedbackIAPatchPanel from './FeedbackIAPatchPanel'

const VERDICT_META = {
  APROVADO: {
    color: 'oklch(72% 0.14 155)',
    bg: 'oklch(72% 0.14 155 / 0.14)',
    icon: CheckCircle2,
    label: 'APROVADO',
  },
  PARCIAL: {
    color: 'oklch(78% 0.14 75)',
    bg: 'oklch(78% 0.14 75 / 0.14)',
    icon: AlertTriangle,
    label: 'PARCIAL',
  },
  REPROVADO: {
    color: 'oklch(68% 0.20 25)',
    bg: 'oklch(68% 0.20 25 / 0.14)',
    icon: XCircle,
    label: 'REPROVADO',
  },
  TECH_ERROR: {
    color: 'var(--fg-3)',
    bg: 'var(--bg-2)',
    icon: AlertTriangle,
    label: 'FALHA TÉCNICA',
  },
}

/** Erro técnico: avaliador não rodou (sem tokens). Não é veredito real do agente. */
function isTechError(ev) {
  if (!ev) return false
  return Boolean(ev.error) && !ev.evaluator_total_tokens
}

function effectiveVerdict(ev) {
  return isTechError(ev) ? 'TECH_ERROR' : ev?.verdict
}

function formatTime(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function VerdictBadge({ verdict, evaluation }) {
  const actual = evaluation ? effectiveVerdict(evaluation) : verdict
  const meta = VERDICT_META[actual] || VERDICT_META.PARCIAL
  const Icon = meta.icon
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 9px', borderRadius: 999,
        fontSize: 11, fontWeight: 600, letterSpacing: 0.04,
        textTransform: 'uppercase',
        color: meta.color,
        background: meta.bg,
        border: `1px solid ${meta.color}33`,
      }}
    >
      <Icon size={12} />
      {meta.label || actual || verdict}
    </span>
  )
}

function ScorePill({ score }) {
  const n = Number(score)
  const safe = Number.isFinite(n) ? n : 0
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 2,
      fontSize: 13, fontWeight: 700, color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums',
    }}>
      {safe.toFixed(1)}
      <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--fg-3)', marginLeft: 2 }}>/10</span>
    </span>
  )
}

function KPI({ icon: Icon, label, value, sub }) {
  return (
    <div className="kpi">
      <div className="kpi-head">
        <div className="kpi-label">
          <Icon size={13} />
          <span>{label}</span>
        </div>
      </div>
      <div className="kpi-value tnum" style={{ fontSize: 22 }}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

function RuleBreakdown({ perRule }) {
  if (!Array.isArray(perRule) || perRule.length === 0) {
    return <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>Sem detalhe por regra.</div>
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {perRule.map((r, i) => {
        const ok = r.ok !== false
        const sev = r.severity || 'low'
        const color = ok
          ? 'oklch(72% 0.14 155)'
          : sev === 'high' ? 'oklch(68% 0.20 25)' : sev === 'medium' ? 'oklch(78% 0.14 75)' : 'var(--fg-3)'
        return (
          <div key={i} style={{
            display: 'grid',
            gridTemplateColumns: '40px 80px 1fr',
            gap: 8,
            padding: '6px 8px',
            borderRadius: 6,
            background: 'var(--bg-2)',
            border: '1px solid var(--line-1)',
            fontSize: 12,
          }}>
            <div style={{ fontWeight: 700, color: 'var(--fg-2)' }}>#{r.rule_id}</div>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              color, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.04,
            }}>
              {ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
              {ok ? 'ok' : sev}
            </div>
            <div>
              <div style={{ color: 'var(--fg-1)', lineHeight: 1.4 }}>
                {r.evidence || (ok ? 'Sem ressalvas.' : 'Violação detectada.')}
              </div>
              {!ok && r.suggestion && (
                <div style={{ color: 'var(--fg-3)', marginTop: 4, fontStyle: 'italic' }}>
                  → {r.suggestion}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function EvaluationItem({ ev, open, onToggle, onRetry, onDelete, busyAction }) {
  const created = formatTime(ev.created_at)
  const turns = ev.turns_count || 0
  const techError = isTechError(ev)
  const retrying = busyAction === 'retry'
  const deleting = busyAction === 'delete'
  return (
    <div style={{
      padding: '10px 14px',
      borderRadius: 10,
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      marginBottom: 6,
      cursor: 'pointer',
    }} onClick={onToggle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <VerdictBadge evaluation={ev} />
        {!isTechError(ev) && <ScorePill score={ev.score} />}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {ev.lead_id
            ? <KommoLeadLink leadId={ev.lead_id} size="sm" />
            : <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{ev.telefone || '—'}</span>}
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 12, color: 'var(--fg-3)' }}>
          <span className="tnum">{created}</span>
          <span className="tnum">{turns} turno{turns === 1 ? '' : 's'} IA</span>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line-1)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{
            display: 'flex', gap: 16, marginBottom: 10, fontSize: 11.5, color: 'var(--fg-3)',
            flexWrap: 'wrap',
          }}>
            <span>Modelo: <strong>{ev.evaluator_model || '-'}</strong></span>
            <span>Tokens: <strong className="tnum">{ev.evaluator_total_tokens || 0}</strong></span>
            <span>Duração: <strong className="tnum">{ev.evaluator_duration_ms ? `${(ev.evaluator_duration_ms / 1000).toFixed(1)}s` : '-'}</strong></span>
            <span>Trigger: <strong>{ev.trigger}</strong></span>
            <span>Status: <strong>{ev.status}</strong></span>
          </div>

          {ev.error && (
            <div style={{
              padding: 8, borderRadius: 6,
              background: techError ? 'var(--bg-2)' : 'oklch(68% 0.20 25 / 0.10)',
              border: `1px solid ${techError ? 'var(--line-1)' : 'oklch(68% 0.20 25 / 0.30)'}`,
              color: techError ? 'var(--fg-2)' : 'oklch(68% 0.20 25)',
              fontSize: 12, marginBottom: 8,
            }}>
              <strong>{techError ? 'Falha técnica:' : 'Falha do avaliador:'}</strong> {ev.error}
              {techError && (
                <div style={{ marginTop: 4, color: 'var(--fg-3)', fontSize: 11.5 }}>
                  Esta avaliação não conta como reprovação real do agente.
                  Você pode retentar (3× automático com backoff) ou excluir.
                </div>
              )}
            </div>
          )}

          {techError && (onRetry || onDelete) && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              {onRetry && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => onRetry(ev.id)}
                  disabled={retrying || deleting}
                  title="Apaga este registro e avalia de novo a mesma conversa"
                >
                  <RotateCcw size={13} className={retrying ? 'spin' : ''} />
                  <span>{retrying ? 'Retentando…' : 'Tentar novamente'}</span>
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => onDelete(ev.id)}
                  disabled={retrying || deleting}
                  title="Remove esta avaliação do histórico"
                  style={{ color: 'oklch(68% 0.20 25)' }}
                >
                  <Trash2 size={13} />
                  <span>{deleting ? 'Excluindo…' : 'Excluir'}</span>
                </button>
              )}
            </div>
          )}

          <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--fg-2)', marginBottom: 6 }}>
            Análise por regra
          </div>
          <RuleBreakdown perRule={ev.per_rule} />

          {(ev.suggestion_text || ev.suggested_new_body) && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--fg-2)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Wand2 size={12} /> Sugestão de patch (somente leitura na Fase 1)
              </div>
              {ev.suggestion_text && (
                <div style={{
                  padding: 10, borderRadius: 6,
                  background: 'var(--bg-2)', border: '1px solid var(--line-1)',
                  fontSize: 12, color: 'var(--fg-1)', whiteSpace: 'pre-wrap', lineHeight: 1.5,
                }}>{ev.suggestion_text}</div>
              )}
              {ev.suggested_new_body && (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--accent-fg)' }}>
                    Ver corpo proposto para a regra #{ev.suggested_rule_id ?? '?'}
                  </summary>
                  <pre style={{
                    marginTop: 6, padding: 10, borderRadius: 6,
                    background: 'var(--bg-2)', border: '1px solid var(--line-1)',
                    fontSize: 11.5, color: 'var(--fg-1)', whiteSpace: 'pre-wrap',
                    fontFamily: 'var(--font-mono)', maxHeight: 360, overflow: 'auto',
                  }}>{ev.suggested_new_body}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const TABS = [
  { id: 'avaliacoes', label: 'Avaliações' },
  { id: 'execucoes', label: 'Execuções' },
  { id: 'patch', label: 'Otimizar Prompt' },
]

export default function FeedbackIA({ kommoScope = null }) {
  const [stats, setStats] = useState(null)
  const [evals, setEvals] = useState([])
  const [evalsError, setEvalsError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('avaliacoes')
  const [filterLead, setFilterLead] = useState('')
  const [filterVerdict, setFilterVerdict] = useState('')
  const [openId, setOpenId] = useState(null)
  const [manualLead, setManualLead] = useState('')
  const [running, setRunning] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [busyById, setBusyById] = useState({})

  // Filtro por escopo de perfil (Agente Inscrição): pega leadIds do funil
  // filtrado e mantém só avaliações desses leads. Quando kommoScope é null
  // (Atendimento ou nenhum), scopedLeadIds.leadIds = null = sem filtro.
  const scopedLeadIds = useScopedLeadIds(kommoScope)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const [s, e] = await Promise.all([
      getStats(),
      listEvaluations({
        leadId: filterLead.trim() || undefined,
        verdict: filterVerdict || undefined,
      }),
    ])
    if (s?.ok) setStats(s)
    if (e?.ok) {
      setEvals(Array.isArray(e.data) ? e.data : [])
      setEvalsError(null)
    } else {
      setEvals([])
      setEvalsError(e?.error || 'Falha ao carregar avaliações')
    }
    setLoading(false)
  }, [filterLead, filterVerdict])

  useEffect(() => { fetchAll() }, [fetchAll])

  const filtered = useMemo(() => {
    let list = evals
    if (filterLead.trim()) {
      const q = filterLead.trim().toLowerCase()
      list = list.filter((r) => String(r.lead_id || '').toLowerCase().includes(q))
    }
    if (filterVerdict) list = list.filter((r) => r.verdict === filterVerdict)
    if (scopedLeadIds.leadIds) {
      // Evaluations sempre têm lead_id, então passWhenMissing=false força
      // descarte de qualquer linha sem lead_id válido (defensivo).
      list = list.filter((r) => leadMatchesScope(r.lead_id, scopedLeadIds, { passWhenMissing: false }))
    }
    return list
  }, [evals, filterLead, filterVerdict, scopedLeadIds])

  const runManual = async () => {
    const id = manualLead.trim()
    if (!id) {
      setStatusMsg('Informe o Lead ID')
      return
    }
    setRunning(true)
    setStatusMsg('')
    const out = await evaluateNow({ leadId: Number(id) || id })
    if (out.ok) {
      setStatusMsg(`Avaliado: ${out.evaluation?.verdict} · ${out.evaluation?.score?.toFixed?.(1)}/10`)
      setManualLead('')
      await fetchAll()
    } else if (out.skipped === 'duplicate') {
      setStatusMsg('Já existe avaliação para essa conversa (sem mensagens novas).')
    } else if (out.skipped === 'no_executions') {
      setStatusMsg('Esse lead não tem execuções da IA registradas.')
    } else {
      setStatusMsg(`Falhou: ${out.error || 'erro desconhecido'}`)
    }
    setRunning(false)
    setTimeout(() => setStatusMsg(''), 6000)
  }

  const handleRetry = useCallback(async (id) => {
    setBusyById((b) => ({ ...b, [id]: 'retry' }))
    setStatusMsg('Retentando avaliação…')
    const out = await retryEvaluation(id)
    if (out.ok && out.evaluation) {
      setStatusMsg(`Re-avaliado: ${out.evaluation.verdict} · ${(out.evaluation.score ?? 0).toFixed?.(1) || out.evaluation.score}/10`)
    } else if (out.ok === false && out.skipped === 'no_executions') {
      setStatusMsg('Lead original sem execuções da IA — retry não aplicável.')
    } else if (out.error) {
      setStatusMsg(`Falha no retry: ${out.error}`)
    } else {
      setStatusMsg('Retry concluído — atualizando lista.')
    }
    setBusyById((b) => { const c = { ...b }; delete c[id]; return c })
    setOpenId(null)
    await fetchAll()
    setTimeout(() => setStatusMsg(''), 8000)
  }, [fetchAll])

  const handleDelete = useCallback(async (id) => {
    if (!window.confirm('Excluir esta avaliação de falha técnica? Não pode ser desfeito.')) return
    setBusyById((b) => ({ ...b, [id]: 'delete' }))
    const out = await deleteEvaluation(id)
    if (out.ok) {
      setStatusMsg(`Avaliação ${id} excluída.`)
    } else {
      setStatusMsg(`Falha ao excluir: ${out.error || 'erro desconhecido'}`)
    }
    setBusyById((b) => { const c = { ...b }; delete c[id]; return c })
    setOpenId(null)
    await fetchAll()
    setTimeout(() => setStatusMsg(''), 6000)
  }, [fetchAll])

  const enabled = stats?.enabledHints
  const disabledReason =
    enabled && !enabled.OPENAI_API_KEY ? 'OPENAI_API_KEY ausente no .env' :
    enabled && !enabled.SUPABASE_URL ? 'SUPABASE_URL ausente no .env' :
    enabled && enabled.FEEDBACK_IA_ENABLED === false ? 'FEEDBACK_IA_ENABLED=false' :
    null

  return (
    <div>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">
            <span>Qualidade</span>
            <span className="sep">/</span>
            <span>Feedback IA</span>
          </div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={20} />
            Feedback IA
          </h1>
          <div className="page-subtitle">
            Avaliação automática da IA contra as Regras 1–22 (override de produção).
            Modelo avaliador: <strong>{stats?.models?.rules_eval?.resolved || '...'}</strong>.
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={fetchAll} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            <span>Atualizar</span>
          </button>
        </div>
      </div>

      <div className="page">
        {disabledReason && (
          <div style={{
            padding: '10px 14px', borderRadius: 10,
            background: 'oklch(78% 0.14 75 / 0.10)',
            border: '1px solid oklch(78% 0.14 75 / 0.30)',
            color: 'var(--fg-2)', fontSize: 13, marginBottom: 14,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <AlertTriangle size={14} style={{ color: 'oklch(78% 0.14 75)' }} />
            <span>Feedback IA está desligado: <strong>{disabledReason}</strong>. Ajuste o .env e reinicie.</span>
          </div>
        )}

        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--bg-2)', border: '1px solid var(--line-1)',
          fontSize: 13, color: 'var(--fg-2)', marginBottom: 14,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Hourglass size={14} style={{ color: 'var(--fg-3)' }} />
          <span>
            Avaliação dispara automaticamente quando o lead <strong>sai do funil</strong> monitorado.
            Pode rodar manualmente abaixo informando o Lead ID.
          </span>
        </div>

        <div className="kpi-grid kpi-grid-3" style={{ marginBottom: 16 }}>
          <KPI icon={CheckCircle2} label="Avaliações hoje" value={stats?.stats?.todayCount ?? '...'} />
          <KPI icon={Calendar} label="Esta semana" value={stats?.stats?.weekCount ?? '...'} />
          <KPI
            icon={Hourglass}
            label="Fila atual"
            value={stats?.watcher?.pendingCount ?? 0}
            sub={stats?.watcher?.draining ? 'Drenando…' : 'Aguardando'}
          />
        </div>

        <div style={{
          display: 'flex', gap: 6, borderBottom: '1px solid var(--line-1)',
          marginBottom: 12,
        }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`tab-btn${tab === t.id ? ' active' : ''}`}
              style={{
                padding: '8px 14px', borderRadius: '6px 6px 0 0',
                border: '1px solid transparent', borderBottom: 'none',
                background: tab === t.id ? 'var(--bg-1)' : 'transparent',
                borderColor: tab === t.id ? 'var(--line-1)' : 'transparent',
                color: tab === t.id ? 'var(--fg-1)' : 'var(--fg-3)',
                fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}
            >
              {t.label}
              {t.id === 'avaliacoes' && evals.length > 0 && (
                <span style={{ marginLeft: 6, color: 'var(--fg-3)', fontWeight: 500 }}>({evals.length})</span>
              )}
            </button>
          ))}
        </div>

        {tab === 'avaliacoes' && (
          <>
            <div style={{
              display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap',
            }}>
              <div style={{
                position: 'relative', display: 'flex', alignItems: 'center',
              }}>
                <Search size={13} style={{ position: 'absolute', left: 10, color: 'var(--fg-3)' }} />
                <input
                  type="text"
                  className="input"
                  placeholder="Lead ID"
                  value={filterLead}
                  onChange={(e) => setFilterLead(e.target.value)}
                  style={{ paddingLeft: 30, width: 160 }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Filter size={13} style={{ color: 'var(--fg-3)' }} />
                <select
                  className="input"
                  value={filterVerdict}
                  onChange={(e) => setFilterVerdict(e.target.value)}
                  style={{ width: 180 }}
                >
                  <option value="">Todos os veredictos</option>
                  <option value="APROVADO">Aprovados</option>
                  <option value="PARCIAL">Parciais</option>
                  <option value="REPROVADO">Reprovados</option>
                </select>
              </div>

              <div style={{ flex: 1 }} />

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="text"
                  className="input"
                  placeholder="Lead ID para avaliar agora"
                  value={manualLead}
                  onChange={(e) => setManualLead(e.target.value)}
                  style={{ width: 220 }}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={runManual}
                  disabled={running || !!disabledReason}
                  title={disabledReason || 'Roda o avaliador agora para esse lead'}
                >
                  <Bot size={14} className={running ? 'spin' : ''} />
                  <span>{running ? 'Avaliando…' : 'Avaliar agora'}</span>
                </button>
              </div>
            </div>

            {statusMsg && (
              <div style={{
                padding: '8px 12px', borderRadius: 8,
                background: 'var(--bg-2)', border: '1px solid var(--line-1)',
                fontSize: 12, color: 'var(--fg-2)', marginBottom: 10,
              }}>{statusMsg}</div>
            )}

            {evalsError && (
              <div style={{
                padding: 12, borderRadius: 10,
                background: 'oklch(68% 0.20 25 / 0.10)',
                border: '1px solid oklch(68% 0.20 25 / 0.30)',
                color: 'var(--fg-1)', fontSize: 12.5, marginBottom: 10,
                display: 'flex', gap: 8, alignItems: 'flex-start',
              }}>
                <AlertTriangle size={14} style={{ color: 'oklch(68% 0.20 25)', flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Erro ao carregar avaliações</div>
                  <div style={{ color: 'var(--fg-2)' }}>{evalsError}</div>
                </div>
              </div>
            )}
            {loading ? (
              <div className="state-msg" style={{ minHeight: 120 }}>
                <div className="loader" />
              </div>
            ) : filtered.length === 0 ? (
              <div style={{
                padding: 36, textAlign: 'center',
                color: 'var(--fg-3)', fontSize: 13,
                background: 'var(--bg-1)', border: '1px dashed var(--line-1)', borderRadius: 12,
              }}>
                <ListChecks size={26} style={{ marginBottom: 8 }} />
                <div style={{ fontWeight: 600, color: 'var(--fg-2)', marginBottom: 4 }}>Nenhuma avaliação ainda</div>
                <div>
                  As avaliações aparecem aqui quando um lead sai do funil monitorado.
                  Você pode forçar manualmente acima.
                </div>
              </div>
            ) : (
              <div>
                {filtered.map((ev) => (
                  <EvaluationItem
                    key={ev.id}
                    ev={ev}
                    open={openId === ev.id}
                    onToggle={() => setOpenId(openId === ev.id ? null : ev.id)}
                    onRetry={handleRetry}
                    onDelete={handleDelete}
                    busyAction={busyById[ev.id]}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'execucoes' && (
          <div style={{
            padding: 24, borderRadius: 12, background: 'var(--bg-1)', border: '1px solid var(--line-1)',
            color: 'var(--fg-2)', fontSize: 13,
          }}>
            <Activity size={14} style={{ marginRight: 6, color: 'var(--fg-3)' }} />
            Para detalhe de cada turno (mensagens, tools, tokens), use a aba <strong>Execuções</strong> do menu.
            Aqui o foco é o veredito agregado por conversa.
          </div>
        )}

        {tab === 'patch' && <FeedbackIAPatchPanel />}
      </div>

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
