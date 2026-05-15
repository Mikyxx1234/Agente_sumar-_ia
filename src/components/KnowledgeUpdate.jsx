import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Database,
  RefreshCw,
  UploadCloud,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Loader2,
  GraduationCap,
  BookOpen,
  DollarSign,
} from 'lucide-react'

const TABLES = [
  {
    key: 'grad_info',
    label: 'Graduação — Info',
    description: 'Conteúdos institucionais, descrição de cursos, ementas, modalidades.',
    icon: GraduationCap,
    accent: '#34d399',
  },
  {
    key: 'grad_preco',
    label: 'Graduação — Preços',
    description: 'Tabela de mensalidades e investimento por curso de graduação.',
    icon: DollarSign,
    accent: '#f472b6',
  },
  {
    key: 'pos_info',
    label: 'Pós — Info',
    description: 'Conteúdos institucionais de pós-graduação, descrição de cursos, áreas.',
    icon: BookOpen,
    accent: '#c084fc',
  },
  {
    key: 'pos_preco',
    label: 'Pós — Preços',
    description: 'Tabela de mensalidades e investimento por curso de pós.',
    icon: DollarSign,
    accent: '#38bdf8',
  },
]

const ACCEPTED = '.pdf,.csv,.xlsx,.xls,.txt,.md'

function formatBytes(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatNumber(n) {
  if (n == null) return '—'
  return n.toLocaleString('pt-BR')
}

export default function KnowledgeUpdate() {
  const [stats, setStats] = useState({})
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState(null)
  const [tableState, setTableState] = useState({}) // por tabela: { file, uploading, result, error, confirmClear, clearing }
  const fileInputs = useRef({})

  const fetchStats = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      const r = await fetch('/api/ai/knowledge/stats')
      const data = await r.json()
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setStats(data.tables || {})
    } catch (e) {
      setStatsError(e.message)
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => { fetchStats() }, [fetchStats])

  const updateTable = (key, patch) => {
    setTableState((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...patch } }))
  }

  const handleFile = (key, file) => {
    updateTable(key, { file, result: null, error: null })
  }

  const handleUpload = async (key) => {
    const ts = tableState[key] || {}
    const file = ts.file
    if (!file) return
    updateTable(key, { uploading: true, error: null, result: null })

    try {
      const form = new FormData()
      form.append('file', file)
      form.append('table', key)
      const r = await fetch('/api/ai/knowledge/upload', { method: 'POST', body: form })
      const data = await r.json()
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`)
      updateTable(key, { uploading: false, result: data, file: null })
      if (fileInputs.current[key]) fileInputs.current[key].value = ''
      fetchStats()
    } catch (e) {
      updateTable(key, { uploading: false, error: e.message })
    }
  }

  const handleClear = async (key) => {
    updateTable(key, { clearing: true, error: null })
    try {
      const r = await fetch('/api/ai/knowledge/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: key }),
      })
      const data = await r.json()
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`)
      updateTable(key, { clearing: false, confirmClear: false, result: { cleared: true, table: key } })
      fetchStats()
    } catch (e) {
      updateTable(key, { clearing: false, confirmClear: false, error: e.message })
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div className="page-breadcrumb">Painel / Base de conhecimento</div>
          <h1 style={{ margin: '6px 0 4px', fontSize: 22, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Database size={22} /> Atualização IA
          </h1>
          <p style={{ color: 'var(--fg-3)', margin: 0, fontSize: 13, maxWidth: 720 }}>
            Faça upload de documentos (PDF, CSV, Excel, TXT, MD) para popular as 4 tabelas vetoriais
            que alimentam o RAG do agente da Faculdade Sumaré. Cada tabela é independente e pode ser
            atualizada ou limpa separadamente.
          </p>
        </div>
        <button className="btn-icon" onClick={fetchStats} disabled={statsLoading} title="Atualizar contagens">
          <RefreshCw size={16} className={statsLoading ? 'spin' : ''} />
        </button>
      </header>

      {statsError && (
        <div style={banner('fail')}>
          <AlertTriangle size={16} /> Erro carregando contagens: {statsError}
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))',
        gap: 16,
      }}>
        {TABLES.map((t) => {
          const ts = tableState[t.key] || {}
          const stat = stats[t.key]
          return (
            <Card key={t.key} t={t} stat={stat} ts={ts}
              onFile={(file) => handleFile(t.key, file)}
              onUpload={() => handleUpload(t.key)}
              onAskClear={() => updateTable(t.key, { confirmClear: true })}
              onCancelClear={() => updateTable(t.key, { confirmClear: false })}
              onConfirmClear={() => handleClear(t.key)}
              fileInputRef={(el) => { fileInputs.current[t.key] = el }}
              statsLoading={statsLoading}
            />
          )
        })}
      </div>

      <section style={{ marginTop: 28, padding: 16, background: 'var(--bg-2)', borderRadius: 10, fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.55 }}>
        <strong style={{ color: 'var(--fg-1)' }}>Como funciona</strong>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li><b>CSV / Excel</b>: cada linha vira um chunk (preserva semântica de planilha, ideal para tabelas de preços).</li>
          <li><b>PDF / TXT / MD</b>: texto extraído e dividido em chunks de ~1000 caracteres com overlap de 100.</li>
          <li>Embeddings gerados com <code>text-embedding-3-small</code> (1536 dims) e inseridos com <code>service_role</code>.</li>
          <li>Limite por upload: 25 MB / 5000 chunks. Para arquivos maiores, divida em partes.</li>
        </ul>
      </section>
    </div>
  )
}

function Card({ t, stat, ts, onFile, onUpload, onAskClear, onCancelClear, onConfirmClear, fileInputRef, statsLoading }) {
  const Icon = t.icon
  return (
    <div style={{
      background: 'var(--bg-2)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: 18,
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: `${t.accent}1a`,
            color: t.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={20} />
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>{t.label}</div>
            <div style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'monospace' }}>{t.key}</div>
          </div>
        </div>
        <div style={{
          padding: '6px 12px',
          borderRadius: 999,
          background: 'var(--bg-3)',
          fontSize: 12,
          fontWeight: 600,
          minWidth: 70,
          textAlign: 'center',
        }} title="Quantidade atual de linhas na tabela">
          {statsLoading && stat == null ? '…' : `${formatNumber(stat?.count)} linhas`}
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-3)', lineHeight: 1.5 }}>{t.description}</p>

      <div style={{
        border: '1px dashed var(--border)',
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'var(--bg-1)',
      }}>
        <input
          type="file"
          accept={ACCEPTED}
          ref={fileInputRef}
          onChange={(e) => onFile(e.target.files?.[0] || null)}
          style={{ display: 'none' }}
          id={`file-${t.key}`}
          disabled={ts.uploading}
        />
        <label htmlFor={`file-${t.key}`} style={{
          padding: '6px 12px',
          background: 'var(--bg-3)',
          borderRadius: 6,
          cursor: ts.uploading ? 'not-allowed' : 'pointer',
          fontSize: 12,
          fontWeight: 500,
          display: 'inline-flex', alignItems: 'center', gap: 6,
          opacity: ts.uploading ? 0.5 : 1,
        }}>
          <FileText size={13} /> Escolher arquivo
        </label>
        <div style={{ fontSize: 12, color: 'var(--fg-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ts.file ? `${ts.file.name} (${formatBytes(ts.file.size)})` : 'PDF · XLSX · CSV · TXT · MD'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onUpload}
          disabled={!ts.file || ts.uploading}
          style={primaryBtn(t.accent, !ts.file || ts.uploading)}
        >
          {ts.uploading ? <Loader2 size={14} className="spin" /> : <UploadCloud size={14} />}
          {ts.uploading ? 'Vetorizando…' : 'Vetorizar e inserir'}
        </button>

        {!ts.confirmClear ? (
          <button
            onClick={onAskClear}
            disabled={ts.uploading || ts.clearing || stat?.count === 0}
            style={dangerBtn(ts.uploading || ts.clearing || stat?.count === 0)}
            title={stat?.count === 0 ? 'Tabela já está vazia' : 'Apagar todas as linhas desta tabela'}
          >
            <Trash2 size={14} /> Limpar
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--danger)' }}>Confirmar?</span>
            <button onClick={onConfirmClear} disabled={ts.clearing} style={confirmBtn(ts.clearing)}>
              {ts.clearing ? <Loader2 size={12} className="spin" /> : 'Sim'}
            </button>
            <button onClick={onCancelClear} disabled={ts.clearing} style={ghostBtn()}>Não</button>
          </div>
        )}
      </div>

      {ts.error && (
        <div style={banner('fail')}>
          <AlertTriangle size={14} /> {ts.error}
        </div>
      )}
      {ts.result && !ts.error && (
        <div style={banner('ok')}>
          <CheckCircle2 size={14} />
          {ts.result.cleared
            ? `Tabela limpa.`
            : `Inseridos ${formatNumber(ts.result.inserted)} chunks (${formatNumber(ts.result.batches)} lotes, ${(ts.result.durationMs / 1000).toFixed(1)}s).`}
        </div>
      )}
    </div>
  )
}

function banner(kind) {
  const map = {
    ok:   { bg: 'var(--success-soft)', fg: 'var(--success)' },
    fail: { bg: 'var(--danger-soft)',  fg: 'var(--danger)' },
  }
  const c = map[kind] || map.ok
  return {
    padding: '8px 12px',
    background: c.bg,
    color: c.fg,
    borderRadius: 6,
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  }
}

function primaryBtn(accent, disabled) {
  return {
    flex: 1,
    padding: '8px 14px',
    background: disabled ? 'var(--bg-3)' : accent,
    color: disabled ? 'var(--fg-3)' : '#0a0a0a',
    border: 'none',
    borderRadius: 6,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    transition: 'transform 0.05s',
  }
}

function dangerBtn(disabled) {
  return {
    padding: '8px 14px',
    background: 'transparent',
    color: disabled ? 'var(--fg-3)' : 'var(--danger)',
    border: `1px solid ${disabled ? 'var(--border)' : 'var(--danger)'}`,
    borderRadius: 6,
    fontSize: 12.5,
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  }
}

function confirmBtn(disabled) {
  return {
    padding: '6px 12px',
    background: 'var(--danger)',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  }
}

function ghostBtn() {
  return {
    padding: '6px 12px',
    background: 'transparent',
    color: 'var(--fg-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 12,
    cursor: 'pointer',
  }
}
