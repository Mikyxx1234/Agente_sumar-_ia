import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'

let _baseUrlCache = null
let _baseUrlPromise = null

async function resolveKommoBaseUrl() {
  if (_baseUrlCache !== null) return _baseUrlCache
  if (_baseUrlPromise) return _baseUrlPromise
  _baseUrlPromise = fetch('/api/scheduler/funnel')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      _baseUrlCache = String(j?.config?.kommoBaseUrl || '').replace(/\/$/, '')
      return _baseUrlCache
    })
    .catch(() => {
      _baseUrlCache = ''
      return ''
    })
  return _baseUrlPromise
}

/**
 * Botão/link para abrir o lead no Kommo em nova aba.
 * Resolve a base URL via /api/scheduler/funnel (cache em memória).
 */
export default function KommoLeadLink({ leadId, studentName, size = 'sm', baseUrl: baseUrlProp }) {
  const [baseUrl, setBaseUrl] = useState(baseUrlProp || _baseUrlCache || '')

  useEffect(() => {
    if (baseUrlProp) {
      setBaseUrl(String(baseUrlProp).replace(/\/$/, ''))
      return
    }
    if (_baseUrlCache !== null) {
      setBaseUrl(_baseUrlCache)
      return
    }
    let cancelled = false
    resolveKommoBaseUrl().then((url) => {
      if (!cancelled) setBaseUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [baseUrlProp])

  if (!leadId) return null
  if (!baseUrl) return null

  const href = `${baseUrl}/leads/detail/${leadId}`
  const isMd = size === 'md'
  const style = {
    height: isMd ? 28 : 22,
    padding: isMd ? '0 10px' : '0 8px',
    fontSize: isMd ? 12 : 11,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    textDecoration: 'none',
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="btn btn-ghost"
      style={style}
      title={`Abrir ${studentName || `lead ${leadId}`} no Kommo`}
    >
      <ExternalLink size={isMd ? 13 : 11} />
      <span>Kommo</span>
    </a>
  )
}
