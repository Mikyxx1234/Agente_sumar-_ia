import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { PROFILE_LIST, getProfile } from '../lib/agentProfiles'

export default function AgentProfileSwitcher({ activeProfileId, onChange }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  const active = getProfile(activeProfileId)
  const ActiveIcon = active.icon

  useEffect(() => {
    if (!open) return undefined
    function onMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function select(id) {
    if (id !== activeProfileId) onChange(id)
    setOpen(false)
  }

  return (
    <div className="profile-switcher" ref={containerRef}>
      <button
        type="button"
        className={`profile-switcher-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className={`brand-mark profile-mark-${active.id}`}>
          <ActiveIcon size={16} />
        </div>
        <div className="brand-text">
          <div className="brand-title">{active.label}</div>
          <div className="brand-sub">{active.sub}</div>
        </div>
        <ChevronDown
          size={14}
          className={`profile-switcher-caret${open ? ' open' : ''}`}
          aria-hidden
        />
      </button>

      {open && (
        <div className="profile-switcher-dropdown" role="listbox" aria-label="Trocar perfil">
          <div className="profile-switcher-dropdown-head">Trocar perfil</div>
          {PROFILE_LIST.map((profile) => {
            const Icon = profile.icon
            const isActive = profile.id === activeProfileId
            return (
              <button
                key={profile.id}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`profile-switcher-item${isActive ? ' active' : ''}`}
                onClick={() => select(profile.id)}
              >
                <div className={`profile-switcher-item-mark profile-mark-${profile.id}`}>
                  <Icon size={14} />
                </div>
                <div className="profile-switcher-item-body">
                  <div className="profile-switcher-item-label">{profile.label}</div>
                  <div className="profile-switcher-item-desc">{profile.description}</div>
                </div>
                {isActive && <Check size={14} className="profile-switcher-item-check" aria-hidden />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
