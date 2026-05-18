import { useState, useEffect } from 'react'
import { ThumbsUp, ThumbsDown, Check, X, MessageSquareWarning, Loader2, AlertCircle } from 'lucide-react'
import {
  getExecutionFeedback,
  saveExecutionFeedback,
  clearExecutionFeedback,
} from '../lib/executionFeedbackStore'

export default function ResponseFeedback({ execution, onChange }) {
  const { id, userMessage, response, model, usage, aiMeta } = execution
  const telefone = usage?.telefone || aiMeta?.telefone || null
  const leadId = usage?.lead_id || usage?.leadId || null
  const origem = usage?.origem || null

  const [rating, setRating] = useState(null)
  const [suggestion, setSuggestion] = useState('')
  const [showNegativeForm, setShowNegativeForm] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [saveError, setSaveError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    getExecutionFeedback(id).then((row) => {
      if (cancelled) return
      if (!row) {
        setRating(null)
        setSuggestion('')
        setShowNegativeForm(false)
        return
      }
      setRating(row.rating)
      setSuggestion(row.suggestion || '')
      setShowNegativeForm(row.rating === 'negative')
    }).catch((e) => {
      if (!cancelled) setLoadError(e.message)
    })
    return () => { cancelled = true }
  }, [id])

  const buildPayload = (nextRating, nextSuggestion = '') => ({
    rating: nextRating,
    suggestion: nextSuggestion,
    userMessage,
    response,
    model,
    telefone,
    leadId,
    origem,
  })

  const persist = async (nextRating, nextSuggestion = '') => {
    setSaving(true)
    setSaveError(null)
    try {
      const data = await saveExecutionFeedback(id, buildPayload(nextRating, nextSuggestion))
      if (!data.ok) {
        setSaveError(data.error || data.code || 'Falha ao salvar')
        return
      }
      if (data.source === 'local') {
        setSaveError(
          data.warning
            ? `Salvo só no navegador (não chegou ao Supabase): ${data.warning}`
            : 'Salvo só no navegador — recarregue a página após reiniciar o servidor.',
        )
        return
      }
      setRating(nextRating)
      setSuggestion(nextSuggestion)
      setShowNegativeForm(nextRating === 'negative')
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
      onChange?.(data.data)
    } catch (e) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handlePositive = async () => {
    if (rating === 'positive') {
      setSaving(true)
      await clearExecutionFeedback(id)
      setRating(null)
      setSuggestion('')
      setShowNegativeForm(false)
      setSaving(false)
      onChange?.(null)
      return
    }
    await persist('positive', '')
  }

  const handleNegativeClick = async () => {
    if (rating === 'negative' && showNegativeForm) {
      setSaving(true)
      await clearExecutionFeedback(id)
      setRating(null)
      setSuggestion('')
      setShowNegativeForm(false)
      setSaving(false)
      onChange?.(null)
      return
    }
    setRating('negative')
    setShowNegativeForm(true)
  }

  const handleSaveNegative = () => {
    const text = suggestion.trim()
    if (!text) return
    persist('negative', text)
  }

  return (
    <div className="response-feedback">
      <div className="response-feedback-head">
        <span className="response-feedback-label">
          <MessageSquareWarning size={13} />
          Avaliar resposta do agente
        </span>
        {saving && (
          <span className="response-feedback-saved" style={{ color: 'var(--fg-3)' }}>
            <Loader2 size={12} className="spin" /> Salvando…
          </span>
        )}
        {!saving && savedFlash && (
          <span className="response-feedback-saved">
            <Check size={12} /> Salvo no banco de treinamento
          </span>
        )}
      </div>

      {(loadError || saveError) && (
        <p className="response-feedback-hint" style={{ color: 'var(--danger)' }}>
          <AlertCircle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          {saveError || loadError}
          {(saveError || '').includes('agent_training_feedback') && (
            <> — rode <code>scripts/sql/agent_training_feedback.sql</code> no Supabase.</>
          )}
        </p>
      )}

      <div className="response-feedback-actions">
        <button
          type="button"
          className={`response-feedback-btn positive${rating === 'positive' ? ' active' : ''}`}
          onClick={handlePositive}
          disabled={saving}
          title={rating === 'positive' ? 'Remover avaliação positiva' : 'Boa resposta — reforço para o agente'}
        >
          <ThumbsUp size={16} />
          <span>Boa resposta</span>
        </button>
        <button
          type="button"
          className={`response-feedback-btn negative${rating === 'negative' ? ' active' : ''}`}
          onClick={handleNegativeClick}
          disabled={saving}
          title={rating === 'negative' ? 'Remover avaliação negativa' : 'Resposta ruim — orientar o agente'}
        >
          <ThumbsDown size={16} />
          <span>Resposta ruim</span>
        </button>
      </div>

      {rating === 'positive' && (
        <p className="response-feedback-hint success">
          Exemplo positivo registrado para treinamento de comportamento.
        </p>
      )}

      {showNegativeForm && (
        <div className="response-feedback-form">
          <label className="response-feedback-form-label" htmlFor={`fb-suggest-${id}`}>
            O que o agente deveria ter feito ou dito? (modelo para próximos atendimentos)
          </label>
          <textarea
            id={`fb-suggest-${id}`}
            className="input response-feedback-textarea"
            rows={4}
            placeholder="Ex.: Não inventar curso. Perguntar qual modalidade o lead quer antes de citar valores..."
            value={suggestion}
            onChange={(e) => setSuggestion(e.target.value)}
            disabled={saving}
          />
          <div className="response-feedback-form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!suggestion.trim() || saving}
              onClick={handleSaveNegative}
            >
              <Check size={14} /> Salvar orientação
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={saving}
              onClick={() => {
                setShowNegativeForm(false)
                if (rating === 'negative' && !suggestion.trim()) {
                  clearExecutionFeedback(id).then(() => {
                    setRating(null)
                    onChange?.(null)
                  })
                }
              }}
            >
              <X size={14} /> Cancelar
            </button>
          </div>
          {rating === 'negative' && suggestion.trim() && !saving && (
            <p className="response-feedback-hint">
              Orientação salva. Clique em &quot;Resposta ruim&quot; novamente para remover.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
