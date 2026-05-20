import { useState, useCallback, useEffect, useRef } from 'react'
import {
  MessageSquare, Search, RefreshCw, Phone, User, Bot,
  AlertCircle, ExternalLink, Hash, Clock, Loader2, ListChecks,
} from 'lucide-react'
import KommoLeadLink from './KommoLeadLink'
import { buildKommoLeadUrl } from '../lib/kommoLinks'

const DEFAULT_LIMIT = 80

function onlyDigits(s) {
  return String(s || '').replace(/[^0-9]/g, '')
}

function isLeadIdLike(s) {
  const t = String(s || '').trim()
  return /^\d{4,10}$/.test(t)
}

function isPhoneLike(s) {
  const d = onlyDigits(s)
  return d.length >= 10 && d.length <= 15
}

function formatTime(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function roleLabel(role) {
  if (role === 'lead') return 'Lead'
  if (role === 'assistente') return 'Assistente'
  if (role === 'system') return 'Sistema'
  if (role === 'tool') return 'Tool'
  return role || 'mensagem'
}

function roleIcon(role) {
  if (role === 'lead') return <User size={13} />
  if (role === 'assistente') return <Bot size={13} />
  return <MessageSquare size={13} />
}

function MessageBubble({ msg }) {
  const isUser = msg.role === 'lead'
  const isBot = msg.role === 'assistente'
  return (
    <div
      className={`msg ${isUser ? 'user' : isBot ? 'assistant' : ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-start' : 'flex-end',
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: 'var(--fg-3)',
          marginBottom: 4,
        }}
      >
        {roleIcon(msg.role)}
        <strong style={{ color: 'var(--fg-2)', fontWeight: 600 }}>{roleLabel(msg.role)}</strong>
        {msg.id != null && <span style={{ fontFamily: 'var(--font-mono)' }}>#{msg.id}</span>}
      </div>
      <div className="msg-bubble" style={{ maxWidth: 640 }}>{msg.content}</div>
    </div>
  )
}

export default function Conversas() {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [thread, setThread] = useState(null)
  const [leadSummary, setLeadSummary] = useState(null)
  const [limit, setLimit] = useState(DEFAULT_LIMIT)
  const [executions, setExecutions] = useState([])
  const lastQueryRef = useRef('')

  const resolveAndFetch = useCallback(async (rawInput) => {
    const query = String(rawInput || '').trim()
    if (!query) return
    setLoading(true)
    setError(null)
    setThread(null)
    setLeadSummary(null)
    setExecutions([])
    lastQueryRef.current = query

    let phone = null
    let lead = null

    try {
      if (isLeadIdLike(query) && !isPhoneLike(query)) {
        const r = await fetch(`/api/kommo/lead/${query}/summary`)
        if (r.ok) {
          const j = await r.json()
          if (j.ok) {
            lead = { id: Number(query), name: j.name || null, phone: j.phone || null }
            if (j.phone) phone = j.phone
          }
        }
        if (!phone) {
          setError(`Lead ${query} sem telefone identificado no Kommo. Tente buscar pelo telefone diretamente.`)
          setLoading(false)
          return
        }
      } else {
        phone = query
        const r = await fetch(`/api/kommo/lead-by-phone?telefone=${encodeURIComponent(query)}`)
        if (r.ok) {
          const j = await r.json()
          const foundLead = j?.ok && j.lead ? j.lead : null
          if (foundLead && foundLead.id) {
            const contactName = foundLead?._embedded?.contacts?.[0]?.name || null
            lead = {
              id: Number(foundLead.id),
              name: (foundLead.name && String(foundLead.name).trim()) || contactName || null,
              phone: query,
            }
          }
        }
      }

      setLeadSummary(lead)

      const mem = await fetch('/api/memory/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefone: phone, limit }),
      })
      const memData = await mem.json().catch(() => ({}))
      if (!mem.ok || !memData.ok) {
        setError(memData.error || `Erro Supabase ${mem.status}`)
        setLoading(false)
        return
      }
      setThread({
        sessionId: memData.session_id,
        table: memData.table,
        count: memData.count,
        mensagens: memData.mensagens || [],
        phone,
      })

      try {
        const digits = onlyDigits(phone)
        if (digits.length >= 8) {
          const tail = digits.slice(-9)
          const url = `/api/supabase/rest/v1/mensagens_ia?select=id,created_at,user_message,response,error,usage&order=created_at.desc&limit=8&user_message=ilike.*${encodeURIComponent(tail)}*`
          const er = await fetch(url)
          if (er.ok) {
            const rows = await er.json().catch(() => [])
            if (Array.isArray(rows)) setExecutions(rows)
          }
        }
      } catch {
        /* silent — execuções vinculadas são opcionais */
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [limit])

  const onSubmit = (e) => {
    e.preventDefault()
    resolveAndFetch(input)
  }

  const onRefresh = () => {
    if (lastQueryRef.current) resolveAndFetch(lastQueryRef.current)
  }

  useEffect(() => {
    if (lastQueryRef.current) resolveAndFetch(lastQueryRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit])

  const kommoUrl = leadSummary?.id ? buildKommoLeadUrl(leadSummary.id) : null

  return (
    <div className="exec-viewer">
      <div className="pg-header">
        <div className="pg-title-group">
          <h1 className="page-title" style={{ fontSize: 18 }}>Conversas</h1>
          <span className="badge">Histórico Supabase</span>
        </div>
        <div className="page-actions">
          {thread && (
            <button type="button" className="btn btn-ghost" onClick={onRefresh} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} /> <span>Atualizar</span>
            </button>
          )}
        </div>
      </div>

      <div className="page" style={{ padding: '12px 24px 0', maxWidth: 'none' }}>
        <form onSubmit={onSubmit} className="prompts-toolbar" style={{ margin: 0 }}>
          <div className="search-wrap" style={{ flex: 1, maxWidth: 460 }}>
            <Search size={14} className="search-icon" />
            <input
              className="input"
              placeholder="Telefone (ex: 5511999999999) ou leadId do Kommo"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading || !input.trim()}
          >
            {loading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
            <span>Buscar</span>
          </button>
          <div className="filter-chips" style={{ marginLeft: 'auto' }}>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)', marginRight: 6 }}>Últimas:</span>
            {[20, 50, 80, 100].map((n) => (
              <button
                key={n}
                type="button"
                className={`chip${limit === n ? ' active' : ''}`}
                onClick={() => setLimit(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </form>
      </div>

      <div className="page" style={{ padding: '14px 24px 24px', maxWidth: 'none', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {error && (
          <div className="mat-info-banner">
            <AlertCircle size={16} /> {error}
          </div>
        )}

        {!thread && !loading && !error && (
          <div className="empty" style={{ marginTop: 40 }}>
            <MessageSquare size={28} className="empty-icon" />
            <div className="empty-title">Busque uma conversa</div>
            <div style={{ fontSize: 12, maxWidth: 380, margin: '0 auto', lineHeight: 1.55 }}>
              Informe o telefone (com DDI/DDD) ou o ID de um lead Kommo. O histórico vem da tabela
              {' '}<code>n8n_chat_histories</code> e é a mesma memória que a IA usa em produção.
            </div>
          </div>
        )}

        {loading && !thread && (
          <div className="state-msg" style={{ height: 200 }}>
            <div className="loader" /><p>Carregando histórico…</p>
          </div>
        )}

        {thread && (
          <>
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-header" style={{ flexWrap: 'wrap', rowGap: 10 }}>
                <div className="card-title">
                  <MessageSquare size={15} style={{ color: 'var(--accent)' }} />
                  Conversa{' '}
                  <span className="card-title-sub" style={{ fontFamily: 'var(--font-mono)' }}>
                    {thread.sessionId}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  {leadSummary?.id ? (
                    <KommoLeadLink leadId={leadSummary.id} studentName={leadSummary.name} size="md" />
                  ) : (
                    <span className="badge warn"><AlertCircle size={11} /> sem lead Kommo</span>
                  )}
                  <span className="badge">
                    {thread.count} mensagem{thread.count === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
              <div className="card-body" style={{ padding: '12px 18px', display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, color: 'var(--fg-3)' }}>
                <span><Phone size={12} /> {thread.phone}</span>
                <span><Hash size={12} /> tabela <code>{thread.table}</code></span>
                {leadSummary?.name && (
                  <span><User size={12} /> {leadSummary.name}</span>
                )}
                {kommoUrl && (
                  <a href={kommoUrl} target="_blank" rel="noopener noreferrer" className="kommo-lead-link kommo-lead-link--sm">
                    <ExternalLink size={11} /> Abrir no Kommo
                  </a>
                )}
              </div>
            </div>

            {executions.length > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-header">
                  <div className="card-title">
                    <ListChecks size={15} style={{ color: 'var(--accent)' }} />
                    Execuções recentes desta conversa
                    <span className="card-title-sub">heurística: telefone aparece no user_message</span>
                  </div>
                </div>
                <div className="card-body" style={{ padding: '6px 14px 12px' }}>
                  <table className="run-table">
                    <thead>
                      <tr>
                        <th>Quando</th>
                        <th>Pergunta</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {executions.map((e) => (
                        <tr key={e.id}>
                          <td className="mono">{formatTime(e.created_at) || '—'}</td>
                          <td>{(e.user_message || '').slice(0, 90) || '(sem texto)'}</td>
                          <td>
                            {e.error ? (
                              <span className="badge danger">erro</span>
                            ) : (
                              <span className="badge success">ok</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div
              className="card"
              style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
            >
              <div className="card-header">
                <div className="card-title">
                  <Clock size={15} style={{ color: 'var(--accent)' }} />
                  Timeline {' '}
                  <span className="card-title-sub">do mais antigo para o mais recente</span>
                </div>
              </div>
              <div className="card-body" style={{ overflowY: 'auto', flex: 1 }}>
                {thread.mensagens.length === 0 ? (
                  <div className="empty">
                    <MessageSquare size={24} className="empty-icon" />
                    <div className="empty-title">Sem mensagens registradas</div>
                    <div style={{ fontSize: 12 }}>
                      A IA ainda não gravou histórico para essa sessão na <code>n8n_chat_histories</code>.
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {thread.mensagens.map((m, i) => (
                      <MessageBubble key={m.id ?? i} msg={m} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
