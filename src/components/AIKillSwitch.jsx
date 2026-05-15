import { useEffect, useState, useCallback } from 'react'
import { Power, PowerOff, Loader2, AlertTriangle } from 'lucide-react'

/**
 * Kill switch da IA — botão proeminente na Sidebar.
 *
 * Quando a IA está LIGADA: mostra "IA LIGADA" em verde. Clicar pede uma
 * razão e DESLIGA.
 * Quando DESLIGADA: mostra "IA DESLIGADA" em vermelho com pulse. Clicar
 * RELIGA imediatamente (sem prompt).
 *
 * O componente faz poll a cada 15s pra refletir mudanças feitas em outras
 * abas/usuários. Após qualquer ação local atualiza otimisticamente.
 */
export default function AIKillSwitch({ onStateChange }) {
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/control/state')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setState(data)
      setError(null)
      onStateChange?.(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [onStateChange])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
  }, [refresh])

  const handleClick = useCallback(async () => {
    if (acting || !state) return
    let reason = null
    if (state.enabled) {
      // Vai DESLIGAR — pedir motivo (opcional)
      const r = window.prompt(
        'Motivo para DESLIGAR a IA?\n\n(opcional — fica registrado no histórico)',
        '',
      )
      if (r === null) return // cancelou
      reason = r.trim() || null
      if (!window.confirm('Tem certeza que quer DESLIGAR a IA?\n\nMensagens novas vão continuar entrando no buffer mas a IA NÃO responderá até você religar.')) {
        return
      }
    }
    setActing(true)
    setError(null)
    try {
      const r = await fetch('/api/ai/control/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, by: 'dashboard' }),
      })
      const data = await r.json()
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`)
      setState(data)
      onStateChange?.(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setActing(false)
    }
  }, [acting, state, onStateChange])

  if (loading) {
    return (
      <div style={styles.shell}>
        <Loader2 size={14} className="spin" />
        <span style={styles.label}>Carregando...</span>
      </div>
    )
  }

  if (error && !state) {
    return (
      <div style={{ ...styles.shell, ...styles.shellError }}>
        <AlertTriangle size={14} />
        <span style={styles.label}>Sem resposta do backend</span>
      </div>
    )
  }

  const enabled = state?.enabled !== false
  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={acting}
        title={
          enabled
            ? 'Clique para DESLIGAR a IA (kill switch).'
            : 'Clique para LIGAR a IA novamente.'
        }
        style={{
          ...styles.btn,
          ...(enabled ? styles.btnOn : styles.btnOff),
          ...(acting ? styles.btnActing : null),
        }}
      >
        {acting ? (
          <Loader2 size={15} className="spin" />
        ) : enabled ? (
          <Power size={15} />
        ) : (
          <PowerOff size={15} />
        )}
        <span style={styles.btnLabel}>
          {enabled ? 'IA LIGADA' : 'IA DESLIGADA'}
        </span>
        <span style={styles.btnHint}>
          {enabled ? 'clique para desligar' : 'clique para ligar'}
        </span>
      </button>
      {error && <div style={styles.errLine}>{error}</div>}
      {state?.updated_by && state.updated_at && state.source !== 'default' && (
        <div style={styles.meta}>
          {new Date(state.updated_at).toLocaleString('pt-BR')} · {state.updated_by}
          {state.reason ? ` — ${state.reason}` : ''}
        </div>
      )}
    </div>
  )
}

const styles = {
  shell: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    borderRadius: 8,
    background: 'var(--bg-2)',
    color: 'var(--fg-3)',
    fontSize: 12,
  },
  shellError: { color: 'var(--danger)' },
  label: { fontWeight: 500 },
  btn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid',
    cursor: 'pointer',
    transition: 'all 120ms ease',
    fontFamily: 'inherit',
    textAlign: 'left',
    position: 'relative',
  },
  btnOn: {
    background: 'var(--success-soft)',
    borderColor: 'oklch(72% 0.14 155 / 0.35)',
    color: 'var(--success)',
  },
  btnOff: {
    background: 'var(--danger-soft)',
    borderColor: 'oklch(68% 0.20 25 / 0.45)',
    color: 'var(--danger)',
    animation: 'aiOffPulse 2s ease-in-out infinite',
  },
  btnActing: { opacity: 0.7, cursor: 'wait' },
  btnLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.3,
  },
  btnHint: { fontSize: 10.5, opacity: 0.8, fontWeight: 500 },
  errLine: { marginTop: 6, fontSize: 11, color: 'var(--danger)' },
  meta: {
    marginTop: 6,
    fontSize: 10.5,
    color: 'var(--fg-3)',
    lineHeight: 1.3,
    paddingLeft: 2,
  },
}
