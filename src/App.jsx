import { useState, useEffect, useCallback } from 'react'
import Sidebar from './components/Sidebar'
import Dashboard from './components/Dashboard'
import PromptViewer from './components/PromptViewer'
import Playground from './components/Playground'
import ExecutionViewer from './components/ExecutionViewer'
import KnowledgeUpdate from './components/KnowledgeUpdate'
import FunilKommo from './components/FunilKommo'
import FeedbackIA from './components/FeedbackIA'
import MatriculasViewer from './components/MatriculasViewer'
import { PowerOff } from 'lucide-react'
import {
  loadProfile, saveProfile,
  loadPageForProfile, savePageForProfile,
  getProfile,
} from './lib/agentProfiles'
import './App.css'

const STORAGE_KEY = 'prompt_edits'
const VERSIONS_KEY = 'prompt_versions'
const DAY_MS = 24 * 60 * 60 * 1000

function extractPrompts(data) {
  const nodes = data.nodes || []
  const prompts = []

  function dig(params, out, depth = 0) {
    if (!params || typeof params !== 'object' || depth > 12) return
    if (Array.isArray(params)) {
      params.forEach((x) => dig(x, out, depth + 1))
      return
    }
    for (const [k, v] of Object.entries(params)) {
      if (k === 'systemMessage' && typeof v === 'string' && v.trim().length > 40) {
        let t = v.trim()
        if (t.startsWith('=') && !t.startsWith('={{')) t = t.slice(1).trim()
        out.push(t)
      } else if (v && typeof v === 'object') {
        dig(v, out, depth + 1)
      }
    }
  }

  for (const node of nodes) {
    const texts = []
    dig(node.parameters || {}, texts)
    const uniq = [...new Set(texts)]
    if (uniq.length === 0) continue

    const p = node.parameters || {}
    const toolDesc =
      typeof p.toolDescription === 'string' && p.toolDescription.trim()
        ? p.toolDescription.trim()
        : typeof p.description === 'string' && p.description.length < 500
          ? p.description
          : ''

    for (let i = 0; i < uniq.length; i++) {
      prompts.push({
        id: `${node.id || node.name || 'n'}-${i}`,
        name: node.name || 'Sem nome',
        type: (node.type || '').split('.').pop() || node.type || '',
        toolDesc: i === 0 ? toolDesc : '',
        body: uniq[i],
      })
    }
  }
  return prompts
}

function loadEdits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}
  } catch { return {} }
}

function loadVersions() {
  try {
    const v = JSON.parse(localStorage.getItem(VERSIONS_KEY)) || {}
    const now = Date.now()
    for (const id in v) {
      v[id] = v[id].filter((entry) => now - entry.ts < DAY_MS)
      if (v[id].length === 0) delete v[id]
    }
    localStorage.setItem(VERSIONS_KEY, JSON.stringify(v))
    return v
  } catch { return {} }
}

export default function App() {
  const [originalPrompts, setOriginalPrompts] = useState([])
  const [edits, setEdits] = useState(loadEdits)
  const [versions, setVersions] = useState(loadVersions)
  // 'server' = persistência em DB (agent_prompts); 'local' = fallback localStorage.
  const [promptMode, setPromptMode] = useState('local')
  const [promptsMeta, setPromptsMeta] = useState({ flagEnabled: false, overridesAvailable: false })
  const [profileId, setProfileId] = useState(() => loadProfile())
  const [page, setPage] = useState(() => loadPageForProfile(loadProfile()))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [aiState, setAiState] = useState(null)

  const handleProfileChange = useCallback((nextProfileId) => {
    setProfileId(nextProfileId)
    saveProfile(nextProfileId)
    setPage(loadPageForProfile(nextProfileId))
  }, [])

  const handleNavigate = useCallback((nextPage) => {
    setPage(nextPage)
    savePageForProfile(profileId, nextPage)
  }, [profileId])

  const loadFromApagarFallback = useCallback(() => {
    fetch('/APAGAR.txt')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((txt) => {
        const data = JSON.parse(txt)
        setOriginalPrompts(extractPrompts(data))
        setPromptMode('local')
        setLoading(false)
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    // Fonte preferida: servidor (persistência em DB agent_prompts).
    // Fallback: APAGAR.txt + localStorage (comportamento antigo).
    fetch('/api/feedback-ia/prompts')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => {
        if (!json?.ok || !Array.isArray(json.data) || json.data.length === 0) {
          throw new Error('prompts indisponíveis no servidor')
        }
        setOriginalPrompts(
          json.data.map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            toolDesc: '',
            body: p.body,
            originalBody: p.baseBody,
            version: p.version,
            overridden: p.overridden,
          })),
        )
        setPromptsMeta({
          flagEnabled: Boolean(json.flagEnabled),
          overridesAvailable: Boolean(json.overridesAvailable),
        })
        setPromptMode('server')
        setLoading(false)
      })
      .catch(() => loadFromApagarFallback())
  }, [loadFromApagarFallback])

  const prompts = promptMode === 'server'
    ? originalPrompts.map((p) => ({ ...p, originalBody: p.originalBody ?? p.body }))
    : originalPrompts.map((p) => ({
        ...p,
        body: edits[p.id] !== undefined ? edits[p.id] : p.body,
        originalBody: p.body,
      }))

  const pushLocalVersion = useCallback((id, previousBody, newBody) => {
    if (previousBody === newBody) return
    setVersions((vPrev) => {
      const list = vPrev[id] || []
      const entry = { body: previousBody, ts: Date.now() }
      const updated = { ...vPrev, [id]: [...list, entry].slice(-20) }
      localStorage.setItem(VERSIONS_KEY, JSON.stringify(updated))
      return updated
    })
  }, [])

  const handleSavePrompt = useCallback((id, newBody) => {
    if (promptMode === 'server') {
      const original = originalPrompts.find((p) => p.id === id)
      const previousBody = original?.body || ''
      fetch(`/api/feedback-ia/prompts/${encodeURIComponent(id)}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: newBody,
          node_name: original?.name,
          node_type: original?.type,
          applied_by: 'dashboard',
        }),
      })
        .then((r) => r.json())
        .then((json) => {
          if (!json?.ok) throw new Error(json?.error || json?.code || 'falha ao salvar')
          pushLocalVersion(id, previousBody, newBody)
          setOriginalPrompts((prev) =>
            prev.map((p) =>
              p.id === id
                ? { ...p, body: newBody, version: json.newVersion ?? p.version, overridden: true }
                : p,
            ),
          )
        })
        .catch((e) => alert(`Não foi possível salvar o prompt no servidor: ${e.message}`))
      return
    }

    // Modo local (fallback)
    setEdits((prev) => {
      const current = prev[id]
      const original = originalPrompts.find((p) => p.id === id)
      const previousBody = current !== undefined ? current : original?.body || ''
      pushLocalVersion(id, previousBody, newBody)
      const next = { ...prev, [id]: newBody }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [promptMode, originalPrompts, pushLocalVersion])

  const handleRestore = useCallback((id, body) => {
    if (promptMode === 'server') {
      handleSavePrompt(id, body)
      return
    }
    setEdits((prev) => {
      const next = { ...prev, [id]: body }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [promptMode, handleSavePrompt])

  const getVersions = useCallback((id) => {
    return (versions[id] || []).slice().reverse()
  }, [versions])

  const aiOff = aiState && aiState.enabled === false

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%' }}>
      <Sidebar
        page={page}
        onNavigate={handleNavigate}
        onAIStateChange={setAiState}
        activeProfileId={profileId}
        onProfileChange={handleProfileChange}
      />
      <main className="main">
        {aiOff && (
          <div className="ai-off-banner" role="alert">
            <PowerOff size={14} />
            <span>
              <strong>IA DESLIGADA</strong> — mensagens recebidas estão sendo DESCARTADAS. Ao religar, a IA responde apenas mensagens novas.
              {aiState.reason ? ` Motivo: ${aiState.reason}.` : ''}
              {aiState.updated_by ? ` Desligada por ${aiState.updated_by}.` : ''}
            </span>
          </div>
        )}
        <div className="main-scroll">
          {loading && (
            <div className="state-msg">
              <div className="loader" />
              <p>Carregando...</p>
            </div>
          )}
          {error && (
            <div className="state-msg">
              <p style={{ color: 'var(--danger)' }}>Erro: {error}</p>
            </div>
          )}
          {!loading && !error && page === 'dashboard' && (
            <Dashboard kommoScope={getProfile('atendimento').kommoScope} />
          )}
          {!loading && !error && page === 'funil-kommo' && (
            <FunilKommo kommoScope={getProfile('atendimento').kommoFunnelScope} />
          )}
          {!loading && !error && page === 'prompts' && (
            <PromptViewer
              prompts={prompts}
              onSave={handleSavePrompt}
              getVersions={getVersions}
              onRestore={handleRestore}
              promptMode={promptMode}
              promptsMeta={promptsMeta}
            />
          )}
          {!loading && !error && page === 'playground' && <Playground prompts={prompts} />}
          {!loading && !error && page === 'executions' && (
            <ExecutionViewer kommoScope={getProfile('atendimento').kommoScope} />
          )}
          {!loading && !error && page === 'feedback-ia' && (
            <FeedbackIA kommoScope={getProfile('atendimento').kommoScope} />
          )}
          {!loading && !error && page === 'knowledge-update' && <KnowledgeUpdate />}
          {!loading && !error && page === 'inscricao-matriculas' && (
            <MatriculasViewer />
          )}
          {!loading && !error && page === 'inscricao-dashboard' && (
            <Dashboard kommoScope={getProfile('inscricao').kommoScope} />
          )}
          {!loading && !error && page === 'inscricao-execucoes' && (
            <ExecutionViewer
              kommoScope={getProfile('inscricao').kommoScope}
              titleOverride="Execuções (Inscrição)"
            />
          )}
          {!loading && !error && page === 'inscricao-feedback' && (
            <FeedbackIA kommoScope={getProfile('inscricao').kommoScope} />
          )}
          {!loading && !error && page === 'inscricao-funil' && (
            <FunilKommo
              kommoScope={getProfile('inscricao').kommoFunnelScope}
              titleOverride="Funil Kommo (Inscrição)"
            />
          )}
        </div>
      </main>
    </div>
  )
}
