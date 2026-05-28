import { Settings } from 'lucide-react'
import AIKillSwitch from './AIKillSwitch'
import AgentProfileSwitcher from './AgentProfileSwitcher'
import { getProfile } from '../lib/agentProfiles'

export default function Sidebar({ page, onNavigate, onAIStateChange, activeProfileId, onProfileChange }) {
  const profile = getProfile(activeProfileId)
  const navItems = profile.nav

  return (
    <aside className="sidebar">
      <AgentProfileSwitcher activeProfileId={profile.id} onChange={onProfileChange} />

      <div style={{ padding: '0 0 12px' }}>
        <AIKillSwitch onStateChange={onAIStateChange} />
      </div>

      <div className="nav-section">Geral</div>
      <nav className="nav-list">
        {navItems.map(({ id, label, icon: Icon }) => (
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
