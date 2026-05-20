import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  RefreshCw, Wand2, AlertTriangle, CheckCircle2, ChevronRight, ChevronDown,
  History, RotateCcw, Send, ShieldAlert, BadgeCheck,
} from 'lucide-react'
import {
  listRules,
  listRuleViolations,
  listRuleVersions,
  generateRulePatch,
  applyRulePatch,
  rollbackRule,
} from '../lib/feedbackIAStore'

function formatTime(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

/** Diff bem simples linha a linha — destaca linhas adicionadas/removidas. */
function SimpleDiff({ before, after }) {
  const linesA = (before || '').split('\n')
  const linesB = (after || '').split('\n')
  const setA = new Set(linesA)
  const setB = new Set(linesB)
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
      fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.5,
    }}>
      <div style={{ padding: 10, background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 6, maxHeight: 420, overflow: 'auto' }}>
        <div style={{ fontWeight: 600, color: 'var(--fg-3)', marginBottom: 6 }}>Antes</div>
        {linesA.map((ln, i) => (
          <div key={i} style={{
            color: setB.has(ln) ? 'var(--fg-2)' : 'oklch(68% 0.20 25)',
            background: setB.has(ln) ? 'transparent' : 'oklch(68% 0.20 25 / 0.08)',
            paddingLeft: 8,
            whiteSpace: 'pre-wrap',
          }}>{ln || '\u00A0'}</div>
        ))}
      </div>
      <div style={{ padding: 10, background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 6, maxHeight: 420, overflow: 'auto' }}>
        <div style={{ fontWeight: 600, color: 'var(--fg-3)', marginBottom: 6 }}>Proposto</div>
        {linesB.map((ln, i) => (
          <div key={i} style={{
            color: setA.has(ln) ? 'var(--fg-2)' : 'oklch(72% 0.14 155)',
            background: setA.has(ln) ? 'transparent' : 'oklch(72% 0.14 155 / 0.10)',
            paddingLeft: 8,
            whiteSpace: 'pre-wrap',
          }}>{ln || '\u00A0'}</div>
        ))}
      </div>
    </div>
  )
}

function RuleHistoryDialog({ ruleId, onClose, onRolledBack }) {
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const r = await listRuleVersions(ruleId)
    setVersions(r?.data || [])
    setLoading(false)
  }, [ruleId])

  useEffect(() => { load() }, [load])

  const doRollback = async (version) => {
    if (!window.confirm(`Voltar regra #${ruleId} para a versão ${version}? Isso vira a versão ativa do agente.`)) return
    setBusy(true)
    setMsg('')
    const r = await rollbackRule(ruleId, version)
    if (r?.ok) {
      setMsg(`Versão ${version} aplicada como ${r.newVersion}.`)
      onRolledBack?.()
    } else {
      setMsg(`Falhou: ${r?.error || 'erro'}`)
    }
    setBusy(false)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--bg-1)', border: '1px solid var(--line-1)', borderRadius: 12,
        maxWidth: 760, width: '100%', maxHeight: '85vh', overflow: 'auto',
        padding: 18,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <History size={16} /> Histórico da regra #{ruleId}
          </h3>
          <button className="btn btn-ghost" onClick={onClose}>Fechar</button>
        </div>
        {msg && <div style={{ padding: 8, marginBottom: 10, background: 'var(--bg-2)', borderRadius: 6, fontSize: 12 }}>{msg}</div>}
        {loading ? <div className="loader" /> : versions.length === 0 ? (
          <div style={{ color: 'var(--fg-3)', fontSize: 13 }}>Nenhuma versão registrada.</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {versions.map((v) => (
              <div key={v.id} style={{
                padding: 10, borderRadius: 8,
                background: 'var(--bg-2)', border: '1px solid var(--line-1)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ fontWeight: 700 }}>v{v.version}</span>
                  <span style={{
                    padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 600,
                    background: v.source === 'seed' ? 'var(--bg-1)' : 'oklch(72% 0.14 155 / 0.14)',
                    color: v.source === 'seed' ? 'var(--fg-3)' : 'oklch(72% 0.14 155)',
                    border: '1px solid var(--line-1)',
                  }}>{v.source}</span>
                  <span style={{ color: 'var(--fg-3)', flex: 1 }}>{formatTime(v.applied_at)} · {v.applied_by || '-'}</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => doRollback(v.version)}
                    title="Aplicar este body como versão nova"
                  >
                    <RotateCcw size={12} /> <span>Restaurar</span>
                  </button>
                </div>
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 11.5, color: 'var(--accent-fg)' }}>Ver corpo</summary>
                  <pre style={{
                    margin: '6px 0 0', padding: 8, fontSize: 11, lineHeight: 1.5,
                    background: 'var(--bg-1)', border: '1px solid var(--line-1)',
                    borderRadius: 4, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto',
                    fontFamily: 'var(--font-mono)',
                  }}>{v.body}</pre>
                </details>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RuleViolationItem({ rule, violation, onPatchApplied }) {
  const [open, setOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [applying, setApplying] = useState(false)
  const [patch, setPatch] = useState(null)
  const [msg, setMsg] = useState('')
  const [editedBody, setEditedBody] = useState('')
  const [showHistory, setShowHistory] = useState(false)

  const counts = violation || { count: 0, severityHigh: 0, samples: [] }

  const gen = async () => {
    setGenerating(true)
    setMsg('')
    setPatch(null)
    const r = await generateRulePatch(rule.id, counts.samples || [])
    if (r?.ok) {
      setPatch(r.patch)
      setEditedBody(r.patch.new_body)
    } else {
      setMsg(`Falhou: ${r?.error || 'erro'}`)
    }
    setGenerating(false)
  }

  const apply = async () => {
    if (!editedBody?.trim()) return
    if (!window.confirm(`Aplicar nova versão da regra #${rule.id}? O agente passa a usar este texto no próximo turno.`)) return
    setApplying(true)
    setMsg('')
    const r = await applyRulePatch(rule.id, editedBody)
    if (r?.ok) {
      setMsg(`Aplicado (v${r.newVersion}).`)
      setPatch(null)
      setEditedBody('')
      onPatchApplied?.()
    } else {
      setMsg(`Falhou: ${r?.error || 'erro'}`)
    }
    setApplying(false)
  }

  const sevColor = counts.severityHigh > 0
    ? 'oklch(68% 0.20 25)'
    : counts.count > 0 ? 'oklch(78% 0.14 75)' : 'var(--fg-3)'

  return (
    <div style={{
      padding: 12, borderRadius: 10,
      background: 'var(--bg-1)', border: '1px solid var(--line-1)',
      marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <div style={{ fontWeight: 700, color: 'var(--fg-2)', minWidth: 28 }}>#{rule.id}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg-1)' }}>{rule.title}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
            v{rule.version} · atualizada {formatTime(rule.updated_at)} por {rule.updated_by || '-'}
          </div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          color: sevColor, fontSize: 12, fontWeight: 600,
        }}>
          <ShieldAlert size={12} />
          {counts.count > 0 ? `${counts.count} viol.` : 'sem violações'}
          {counts.severityHigh > 0 && (
            <span style={{ background: 'oklch(68% 0.20 25 / 0.14)', padding: '1px 6px', borderRadius: 999, fontSize: 10 }}>
              {counts.severityHigh} críticas
            </span>
          )}
        </div>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>

      {open && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line-1)' }}>
          {/* Amostras de violação */}
          {counts.samples?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--fg-2)', marginBottom: 6 }}>
                Evidências recentes ({counts.samples.length}/{counts.count})
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                {counts.samples.map((s, i) => (
                  <div key={i} style={{
                    fontSize: 11.5, padding: 8,
                    background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 6,
                  }}>
                    <div style={{ color: 'var(--fg-3)', marginBottom: 2 }}>
                      lead={s.leadId || '?'} · severity={s.severity}
                    </div>
                    <div style={{ color: 'var(--fg-1)' }}>{s.evidence}</div>
                    {s.suggestion && (
                      <div style={{ color: 'oklch(72% 0.14 155)', marginTop: 4, fontStyle: 'italic' }}>
                        → {s.suggestion}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Corpo atual da regra */}
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--accent-fg)' }}>
              Ver corpo atual (v{rule.version})
            </summary>
            <pre style={{
              margin: '6px 0 0', padding: 10, fontSize: 11, lineHeight: 1.5,
              background: 'var(--bg-2)', border: '1px solid var(--line-1)',
              borderRadius: 4, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto',
              fontFamily: 'var(--font-mono)',
            }}>{rule.body}</pre>
          </details>

          {/* Botões de ação */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <button
              type="button"
              className="btn"
              onClick={gen}
              disabled={generating}
              title="Chama gpt-5 com as evidências para gerar uma proposta de novo corpo"
            >
              <Wand2 size={14} className={generating ? 'spin' : ''} />
              <span>{generating ? 'Gerando…' : 'Gerar patch (gpt-5)'}</span>
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setShowHistory(true)}
            >
              <History size={14} /> <span>Histórico</span>
            </button>
          </div>

          {msg && (
            <div style={{
              padding: 8, marginBottom: 10, borderRadius: 6,
              background: 'var(--bg-2)', fontSize: 12, color: 'var(--fg-2)',
            }}>{msg}</div>
          )}

          {/* Patch sugerido */}
          {patch && (
            <div>
              <div style={{
                padding: 10, marginBottom: 10, borderRadius: 8,
                background: 'oklch(78% 0.14 75 / 0.08)',
                border: '1px solid oklch(78% 0.14 75 / 0.30)',
                fontSize: 12, color: 'var(--fg-1)', lineHeight: 1.5,
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Justificativa do modelo</div>
                <div style={{ color: 'var(--fg-2)' }}>{patch.justification}</div>
                {patch.risk_notes && (
                  <div style={{ marginTop: 8, color: 'oklch(78% 0.14 75)' }}>
                    <strong>Atenção:</strong> {patch.risk_notes}
                  </div>
                )}
              </div>

              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--fg-2)', marginBottom: 6 }}>Diff</div>
              <SimpleDiff before={rule.body} after={editedBody} />

              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--fg-2)', margin: '12px 0 6px' }}>
                Editar antes de aplicar (opcional)
              </div>
              <textarea
                value={editedBody}
                onChange={(e) => setEditedBody(e.target.value)}
                rows={10}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.5,
                  padding: 10, borderRadius: 6,
                  background: 'var(--bg-2)', border: '1px solid var(--line-1)',
                  color: 'var(--fg-1)',
                }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  className="btn"
                  style={{ background: 'oklch(72% 0.14 155 / 0.18)', borderColor: 'oklch(72% 0.14 155 / 0.40)' }}
                  onClick={apply}
                  disabled={applying || !editedBody.trim()}
                >
                  <Send size={14} className={applying ? 'spin' : ''} />
                  <span>{applying ? 'Aplicando…' : 'Aprovar e ativar'}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { setPatch(null); setEditedBody('') }}
                >
                  Descartar
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showHistory && (
        <RuleHistoryDialog
          ruleId={rule.id}
          onClose={() => setShowHistory(false)}
          onRolledBack={() => { setShowHistory(false); onPatchApplied?.() }}
        />
      )}
    </div>
  )
}

export default function FeedbackIAPatchPanel() {
  const [rules, setRules] = useState([])
  const [violations, setViolations] = useState([])
  const [totalEvals, setTotalEvals] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [cache, setCache] = useState(null)
  const [days, setDays] = useState(30)

  const load = useCallback(async () => {
    setLoading(true)
    const [r1, r2] = await Promise.all([listRules(), listRuleViolations({ days })])
    if (r1?.ok) {
      setRules(r1.data || [])
      setCache(r1.cache || null)
      setError(null)
    } else {
      setRules([])
      setError(r1?.error || 'Falha ao carregar regras')
      setCache(r1?.cache || null)
    }
    if (r2?.ok) {
      setViolations(r2.data || [])
      setTotalEvals(r2.totalEvaluations || 0)
    } else {
      setViolations([])
    }
    setLoading(false)
  }, [days])

  useEffect(() => { load() }, [load])

  const violationByRule = useMemo(() => {
    const map = new Map()
    for (const v of violations) map.set(v.ruleId, v)
    return map
  }, [violations])

  if (loading) {
    return <div className="state-msg" style={{ minHeight: 120 }}><div className="loader" /></div>
  }

  if (error || rules.length === 0) {
    return (
      <div style={{
        padding: 18, borderRadius: 10,
        background: 'oklch(78% 0.14 75 / 0.10)', border: '1px solid oklch(78% 0.14 75 / 0.30)',
        color: 'var(--fg-1)', fontSize: 13, lineHeight: 1.5,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <AlertTriangle size={16} style={{ color: 'oklch(78% 0.14 75)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Fase 2 ainda não está pronta</div>
            <div style={{ color: 'var(--fg-2)' }}>{error || 'Tabela agent_rules não encontrada'}</div>
            <div style={{ marginTop: 10, fontSize: 12 }}>
              Rode <code>scripts/sql/agent_rules.sql</code> no Supabase Studio (mesmo projeto de
              <code> ai_rule_evaluations</code>). No próximo boot, o servidor faz seed automático
              das 22 regras a partir do override hardcoded e a aba começa a funcionar.
            </div>
            {cache && (
              <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--fg-3)' }}>
                Source atual do prompt: <strong>{cache.source}</strong> ·
                {' '}{cache.rulesCount} regra(s) em cache
                {cache.error && <> · erro: {cache.error}</>}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  const sortedRules = [...rules].sort((a, b) => {
    const va = violationByRule.get(a.id)?.severityHigh || 0
    const vb = violationByRule.get(b.id)?.severityHigh || 0
    if (vb !== va) return vb - va
    const ca = violationByRule.get(a.id)?.count || 0
    const cb = violationByRule.get(b.id)?.count || 0
    if (cb !== ca) return cb - ca
    return a.id - b.id
  })

  return (
    <div>
      <div style={{
        padding: '10px 14px', borderRadius: 10,
        background: 'var(--bg-2)', border: '1px solid var(--line-1)',
        fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 14,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <BadgeCheck size={14} style={{ color: 'oklch(72% 0.14 155)' }} />
        <span>
          Source ativa do prompt do agente: <strong>{cache?.source || '...'}</strong> ·
          {' '}<strong>{cache?.rulesCount || rules.length}</strong> regras carregadas ·
          {' '}<strong>{totalEvals}</strong> avaliações analisadas nos últimos
          {' '}<select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{
            background: 'transparent', border: 'none', color: 'inherit', fontWeight: 700, cursor: 'pointer',
          }}>
            <option value={7}>7</option>
            <option value={15}>15</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
            <option value={90}>90</option>
          </select> dias
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={load}>
          <RefreshCw size={14} /> <span>Atualizar</span>
        </button>
      </div>

      <div>
        {sortedRules.map((r) => (
          <RuleViolationItem
            key={r.id}
            rule={r}
            violation={violationByRule.get(r.id)}
            onPatchApplied={load}
          />
        ))}
      </div>
    </div>
  )
}
