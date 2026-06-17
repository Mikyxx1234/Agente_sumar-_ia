import {
  MessageSquare, Zap, DollarSign, AlertTriangle, Clock,
  TrendingUp, Database, Search, RefreshCw, Calendar, Filter, Tag,
  Wand2, Bot, Wrench, Layers, Send
} from 'lucide-react'
import { useState, useEffect, useMemo, useCallback } from 'react'

const TOPIC_LABELS = {
  buscar_conhecimento: 'Busca base Sumaré (RAG)',
  buscar_precos: 'Pediu preço',
  buscar_informacoes: 'Pediu informações do curso',
  buscar_pos: 'Pediu pós-graduação',
  buscar_perguntas: 'Fez uma pergunta (FAQ)',
  localizacao: 'Pediu polo / localização',
  inscricao: 'Inscrição / matrícula',
  distribuir_humano: 'Distribuição para humano',
}

const TOPIC_COLORS = {
  'Busca base Sumaré (RAG)': '#2dd4bf',
  'Pediu preço': '#f472b6',
  'Pediu informações do curso': '#34d399',
  'Pediu pós-graduação': '#c084fc',
  'Fez uma pergunta (FAQ)': '#fbbf24',
  'Pediu polo / localização': '#38bdf8',
  'Inscrição / matrícula': '#f87171',
  'Distribuição para humano': '#94a3b8',
}

const FALLBACK_TOPIC_COLORS = [
  '#f472b6', '#34d399', '#c084fc', '#fbbf24',
  '#38bdf8', '#f87171', '#94a3b8', '#a3e635',
]

function resolveTopicColor(label, index) {
  return TOPIC_COLORS[label] || FALLBACK_TOPIC_COLORS[index % FALLBACK_TOPIC_COLORS.length]
}

function formatBRL(value) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function toInputDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getDayLabel(date) {
  return date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

/* ── UI Components ── */

function KPI({ label, icon: Icon, value, unit, sub }) {
  return (
    <div className="kpi">
      <div className="kpi-head">
        <div className="kpi-label">
          <Icon size={13} />
          <span>{label}</span>
        </div>
      </div>
      <div className="kpi-value tnum">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

function AreaChart({ data }) {
  if (data.length === 0) return <div className="empty">Sem dados no período</div>
  const W = 620, H = 200, padL = 34, padR = 10, padT = 8, padB = 24
  const max = Math.max(...data.map(d => d.value)) * 1.15 || 1
  const stepX = data.length > 1 ? (W - padL - padR) / (data.length - 1) : 0
  const pts = data.map((d, i) => [padL + i * stepX, padT + (H - padT - padB) * (1 - d.value / max)])
  const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ')
  const area = line + ` L${pts[pts.length - 1][0]},${H - padB} L${padL},${H - padB} Z`
  const yTicks = [max, max * 0.66, max * 0.33, 0].map(v => Math.round(v))

  return (
    <div className="chart-wrap">
      <div className="chart-y-labels">
        {yTicks.map((v, i) => <span key={i}>{v}</span>)}
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {yTicks.map((v, i) => {
          const y = padT + ((H - padT - padB) * i) / 3
          return <line key={'g'+i} x1={padL} x2={W - padR} y1={y} y2={y} stroke="var(--line-subtle)" strokeDasharray={i === 3 ? '' : '2 4'} />
        })}
        <path d={area} fill="url(#area-grad)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {pts.map((p, i) => <circle key={'p'+i} cx={p[0]} cy={p[1]} r="3" fill="var(--bg-2)" stroke="var(--accent)" strokeWidth="2" />)}
      </svg>
      <div className="chart-x-labels tnum">
        {data.map((d, i) => <span key={i}>{d.label}</span>)}
      </div>
    </div>
  )
}

/**
 * Breakdown de custo por componente do agente.
 *
 * Mostra cada parte do pipeline (orquestrador, reescrita de query,
 * embeddings, tools auxiliares) com seu custo, % do total, modelo
 * usado e tokens consumidos. O custo total acima do card é a soma
 * dessas barras (igual ao KPI "Custo estimado").
 */
function CostBreakdown({ items, total }) {
  if (!items || items.length === 0) return <div className="empty">Sem dados no período</div>
  const maxCost = Math.max(...items.map((d) => d.cost)) || 1
  return (
    <div className="hbars">
      {items.map((d, i) => {
        const Icon = d.icon
        const pct = total > 0 ? (d.cost / total) * 100 : 0
        const fillPct = (d.cost / maxCost) * 100
        const tokensLabel = d.tokens > 0 ? `${d.tokens.toLocaleString('pt-BR')} tokens` : 'sem uso'
        const modelsLabel = d.models?.length ? d.models.join(', ') : '—'
        return (
          <div key={d.key || i} className="hbar-row">
            <div className="hbar-label-row">
              <div className="hbar-name">
                <Icon size={13} style={{ color: d.color, flexShrink: 0 }} />
                <span>{d.label}</span>
                <span className="card-title-sub" style={{ marginLeft: 6, fontSize: 11 }}>
                  {modelsLabel} · {tokensLabel}
                </span>
              </div>
              <div className="hbar-value tnum">
                {formatBRL(d.cost)}
                <span className="hbar-pct">{pct.toFixed(1)}%</span>
              </div>
            </div>
            <div className="hbar-track">
              <div
                className="hbar-fill"
                style={{ width: `${fillPct}%`, background: d.color }}
                title={d.hint}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function HBars({ data, total }) {
  if (data.length === 0) return <div className="empty">Sem dados no período</div>
  const max = Math.max(...data.map(d => d.value))
  return (
    <div className="hbars">
      {data.map((d, i) => (
        <div key={i} className="hbar-row">
          <div className="hbar-label-row">
            <div className="hbar-name">
              <span className="hbar-rank tnum">{i + 1}</span>
              <span>{d.label}</span>
            </div>
            <div className="hbar-value tnum">
              {d.value.toLocaleString('pt-BR')}
              <span className="hbar-pct">{((d.value / (total || 1)) * 100).toFixed(1)}%</span>
            </div>
          </div>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function Donut({ data }) {
  if (data.length === 0) return <div className="empty">Sem dados no período</div>
  const R = 56, SW = 14, C = 2 * Math.PI * R
  const total = data.reduce((s, d) => s + d.value, 0)
  const topicsCount = data.length
  const GAP = data.length > 1 ? 3 : 0
  let offset = 0

  return (
    <div className="donut-wrap">
      <div style={{ position: 'relative', width: 150, height: 150, flexShrink: 0 }}>
        <svg width="150" height="150" viewBox="0 0 150 150">
          <circle cx="75" cy="75" r={R} fill="none" stroke="var(--bg-4)" strokeWidth={SW} />
          {data.map((d, i) => {
            const fullLen = (d.value / total) * C
            const len = Math.max(0, fullLen - GAP)
            const el = (
              <circle key={i} cx="75" cy="75" r={R} fill="none"
                stroke={d.color} strokeWidth={SW} strokeLinecap="round"
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 75 75)" />
            )
            offset += fullLen
            return el
          })}
        </svg>
        <div className="donut-center">
          <div>
            <div className="donut-center-val tnum">{topicsCount.toLocaleString('pt-BR')}</div>
            <div className="donut-center-lbl">{topicsCount === 1 ? 'tópico' : 'tópicos'}</div>
          </div>
        </div>
      </div>
      <div className="donut-legend">
        {data.map((d, i) => (
          <div key={i} className="legend-row" style={{ '--topic-color': d.color }}>
            <span className="legend-dot" style={{ background: d.color }} />
            <span className="legend-name">{d.label}</span>
            <span className="legend-val tnum">{d.value.toLocaleString('pt-BR')}</span>
            <span className="legend-pct tnum">{((d.value / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Main Dashboard ── */

const PRESETS = [
  { label: 'Hoje', days: 0 },
  { label: '3 dias', days: 3 },
  { label: '7 dias', days: 7 },
  { label: '15 dias', days: 15 },
  { label: '30 dias', days: 30 },
]

export default function Dashboard({ kommoScope = null }) {
  const [metrics, setMetrics] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activePreset, setActivePreset] = useState(3)

  const today = toInputDate(new Date())
  const sevenAgo = toInputDate(new Date(Date.now() - 6 * 86400000))
  const threeAgo = toInputDate(new Date(Date.now() - 2 * 86400000))
  const [startDate, setStartDate] = useState(threeAgo)
  const [endDate, setEndDate] = useState(today)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const params = new URLSearchParams({ startDate, endDate })
      if (kommoScope) {
        params.set('scopeMode', kommoScope.mode || 'include')
        if (kommoScope.pipelineId) params.set('pipelineId', String(kommoScope.pipelineId))
        if (kommoScope.statusIds?.length) params.set('statusIds', kommoScope.statusIds.join(','))
      } else {
        params.set('scopeMode', 'all')
      }
      const r = await fetch(`/api/dashboard/metrics?${params}`)
      const ct = r.headers.get('content-type') || ''
      if (!ct.includes('application/json')) {
        const text = await r.text()
        throw new Error(
          /<!DOCTYPE/i.test(text)
            ? 'Servidor demorou demais ou Supabase indisponível — tente Hoje ou 3 dias'
            : `Resposta inválida (HTTP ${r.status})`,
        )
      }
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setMetrics(j)
    } catch (e) {
      setLoadError(e.message)
      setMetrics(null)
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, kommoScope])

  useEffect(() => { fetchData() }, [fetchData])

  const applyPreset = (days) => {
    const end = new Date()
    const start = new Date()
    if (days > 0) start.setDate(start.getDate() - (days - 1))
    setStartDate(toInputDate(start))
    setEndDate(toInputDate(end))
    setActivePreset(days)
  }

  const stats = useMemo(() => {
    if (!metrics) {
      return {
        messagesCount: 0,
        whatsappSentExecutions: 0,
        whatsappPartsCount: 0,
        tokens: 0,
        cost: 0,
        errorsCount: 0,
        avgTime: 0,
        chartData: [],
        toolsData: [],
        topicsData: [],
        costBreakdown: [],
        meta: null,
      }
    }

    const iconMap = {
      orchestrator: { icon: Bot, color: '#34d399', hint: 'LLM principal que decide tools e responde ao cliente.' },
      rewrite: { icon: Wand2, color: '#c084fc', hint: 'Reescrita da pergunta antes do RAG.' },
      embeddings: { icon: Layers, color: '#38bdf8', hint: 'text-embedding-3-small para buscar documentos.' },
      auxTools: { icon: Wrench, color: '#f472b6', hint: 'LLMs internos de tools auxiliares.' },
    }

    const costBreakdown = (metrics.costBreakdown || []).map((row) => ({
      ...row,
      tokens: 0,
      models: [],
      ...(iconMap[row.key] || { icon: Bot, color: '#94a3b8', hint: '' }),
    }))

    return {
      messagesCount: metrics.messagesCount || 0,
      whatsappSentExecutions: metrics.whatsappSentExecutions || 0,
      whatsappPartsCount: metrics.whatsappPartsCount || 0,
      tokens: metrics.tokens || 0,
      cost: metrics.cost || 0,
      errorsCount: metrics.errorsCount || 0,
      avgTime: metrics.avgTime || 0,
      chartData: metrics.chartData || [],
      toolsData: metrics.toolsData || [],
      topicsData: metrics.topicsData || [],
      costBreakdown,
      meta: metrics.meta || null,
    }
  }, [metrics])

  const periodLabel = startDate === endDate
    ? 'Hoje'
    : `${new Date(startDate).toLocaleDateString('pt-BR')} — ${new Date(endDate).toLocaleDateString('pt-BR')}`

  return (
    <div>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">
            <span>Painel</span>
            <span className="sep">/</span>
            <span>Visão geral</span>
          </div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-subtitle">Acompanhe o desempenho da IA em tempo real.</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={fetchData}>
            <RefreshCw size={14} />
            <span>Atualizar</span>
          </button>
        </div>
      </div>

      <div className="page">
        <div className="dash-toolbar">
          <div className="date-presets">
            {PRESETS.map((p) => (
              <button key={p.days} className={activePreset === p.days ? 'active' : ''} onClick={() => applyPreset(p.days)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="date-range">
            <Calendar size={13} />
            <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} />
            <span className="sep">—</span>
            <input type="date" value={endDate} min={startDate} max={today} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div className="spacer" />
          <div className="period-summary">
            <span>{periodLabel}</span>
            <span>·</span>
            <strong className="tnum">{stats.messagesCount}</strong>
            <span>execuções IA</span>
            {stats.meta?.fetchedTotal != null && stats.meta.fetchedTotal !== stats.messagesCount && (
              <>
                <span>·</span>
                <span className="card-title-sub">de {stats.meta.fetchedTotal.toLocaleString('pt-BR')} no período</span>
              </>
            )}
          </div>
        </div>

        {loadError && (
          <div className="state-msg" style={{ color: 'var(--danger)', minHeight: 48 }}>
            Erro ao carregar métricas: {loadError}
          </div>
        )}

        {loading ? (
          <div className="state-msg" style={{ minHeight: 200 }}>
            <div className="loader" />
            <div style={{ marginTop: 12, color: 'var(--text-2)', fontSize: 13 }}>
              Carregando métricas… períodos longos podem levar até 2 minutos.
            </div>
          </div>
        ) : (
          <>
            <div className="kpi-grid">
              <KPI
                icon={MessageSquare}
                label="Execuções IA"
                value={stats.messagesCount.toLocaleString('pt-BR')}
                sub="Turnos processados pelo agente"
              />
              <KPI
                icon={Send}
                label="WhatsApp enviados"
                value={stats.whatsappSentExecutions.toLocaleString('pt-BR')}
                sub={
                  stats.whatsappPartsCount > stats.whatsappSentExecutions
                    ? `${stats.whatsappPartsCount.toLocaleString('pt-BR')} partes enviadas na API`
                    : stats.messagesCount > 0
                      ? `${((stats.whatsappSentExecutions / stats.messagesCount) * 100).toFixed(0)}% das execuções com resposta`
                      : 'Confirmados na API WhatsApp'
                }
              />
              <KPI icon={Zap} label="Tokens usados" value={stats.tokens > 1000000 ? (stats.tokens/1000000).toFixed(2) : stats.tokens.toLocaleString('pt-BR')} unit={stats.tokens > 1000000 ? 'M' : ''} sub="Total de tokens consumidos" />
              <KPI icon={DollarSign} label="Custo estimado" value={formatBRL(stats.cost)} sub="Soma de todos os componentes" />
              <KPI icon={Clock} label="Tempo médio" value={stats.avgTime > 0 ? (stats.avgTime / 1000).toFixed(1) : '-'} unit={stats.avgTime > 0 ? 's' : ''} />
              <KPI icon={AlertTriangle} label="Erros" value={stats.errorsCount} sub={stats.messagesCount > 0 ? `${((stats.errorsCount / stats.messagesCount) * 100).toFixed(1)}% do total` : ''} />
            </div>

            <div className="card">
              <div className="card-header">
                <div className="card-title">
                  <DollarSign size={14} />
                  Custo por componente
                </div>
                <span className="card-title-sub">{formatBRL(stats.cost)} no total</span>
              </div>
              <div className="card-body">
                <CostBreakdown items={stats.costBreakdown} total={stats.cost} />
              </div>
            </div>

            <div className="dash-grid">
              <div className="dash-col">
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">
                      <TrendingUp size={14} />
                      Mensagens por dia
                    </div>
                    <span className="card-title-sub">Execuções IA por dia civil (SP)</span>
                  </div>
                  <div className="card-body">
                    <AreaChart data={stats.chartData} />
                  </div>
                </div>
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">
                      <Database size={14} />
                      Tools mais usadas
                    </div>
                    <span className="card-title-sub">{stats.toolsData.reduce((s, d) => s + d.value, 0).toLocaleString('pt-BR')} chamadas</span>
                  </div>
                  <div className="card-body">
                    <HBars data={stats.toolsData} total={stats.toolsData.reduce((s, d) => s + d.value, 0)} />
                  </div>
                </div>
              </div>
              <div className="dash-col">
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">
                      <Tag size={14} />
                      Tópicos mais pedidos
                    </div>
                  </div>
                  <div className="card-body">
                    <Donut data={stats.topicsData.map((d, i) => ({ ...d, color: resolveTopicColor(d.label, i) }))} />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
