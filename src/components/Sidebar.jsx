import { Sparkles, LayoutDashboard, FileText, FlaskConical, ListChecks, Settings, Database, GraduationCap, Filter } from 'lucide-react'
import AIKillSwitch from './AIKillSwitch'

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'funil-kommo', label: 'Funil Kommo', icon: Filter },
  { id: 'prompts', label: 'Prompts', icon: FileText },
  { id: 'playground', label: 'Teste IA', icon: FlaskConical },
  { id: 'executions', label: 'Execuções', icon: ListChecks },
  { id: 'matriculas', label: 'Matrículas', icon: GraduationCap },
  { id: 'knowledge-update', label: 'Atualização IA', icon: Database },
]

export default function Sidebar({ page, onNavigate, onAIStateChange }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Sparkles size={16} />
        </div>
        <div className="brand-text">
          <div className="brand-title">Agente Comercial</div>
          <div className="brand-sub">Painel da IA</div>
        </div>
      </div>

      <div style={{ padding: '0 0 12px' }}>
        <AIKillSwitch onStateChange={onAIStateChange} />
      </div>

      <div className="nav-section">Geral</div>
      <nav className="nav-list">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item${page === id ? ' active' : ''}`}
            onClick={() => onNavigate(id)}
          >
            <Icon size={16} className="nav-icon" />
            <span className="nav-item-label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="nav-footer">
        <div className="workspace">
          <div className="workspace-avatar">AC</div>
          <div className="workspace-info">
            <div className="workspace-name">Produção</div>
            <div className="workspace-status">online</div>
          </div>
        </div>
        <button
          type="button"
          className="btn-icon"
          style={{ width: 28, height: 28 }}
          title="Abrir configurações do Teste IA"
          aria-label="Configurações do Teste IA"
          onClick={() => {
            sessionStorage.setItem('pg_open_config', '1')
            if (page === 'playground') {
              window.dispatchEvent(new CustomEvent('playground-open-config'))
            } else {
              onNavigate('playground')
            }
          }}
        >
          <Settings size={14} />
        </button>
      </div>
    </aside>
  )
}
