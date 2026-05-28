import { Info } from 'lucide-react'

export default function InscricaoScopeBanner({ label }) {
  return (
    <div className="inscricao-scope-banner" role="status">
      <span className="inscricao-scope-banner-icon" aria-hidden>
        <Info size={14} />
      </span>
      <div className="inscricao-scope-banner-text">
        <strong>{label || 'Perfil Agente Inscrição'}</strong>
        <span>
          Os dados desta aba ainda não estão filtrados por agente —
          mostram informações de todos os agentes. O critério de
          separação será aplicado quando definido (Fase 2 do redesign de perfis).
        </span>
      </div>
    </div>
  )
}
