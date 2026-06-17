/**
 * Helpers de escopo de funil — usados pelo perfil Agente Inscrição para
 * filtrar dados client-side por leadId.
 *
 * Fluxo:
 *  1. Componente recebe `kommoScope` ({ pipelineId, statusIds }) via prop
 *  2. Chama `fetchScopedLeadIds(kommoScope)` → busca leads do funil
 *     filtrado pelo endpoint `/api/scheduler/funnel?statusIds=...`
 *  3. Filtra suas próprias listas (execuções, evaluations, etc.) por
 *     `leadId ∈ Set<leadIds>`
 *
 * Quando o backend não está disponível (proxy retorna 502/ECONNREFUSED),
 * `fetchScopedLeadIds` devolve `{ ok: false, leadIds: null }` — o
 * componente decide se mostra aviso ou cai num fallback (sem filtro).
 */

import { useEffect, useState } from 'react'

/**
 * Extrai o lead_id do Kommo de uma execução, olhando nos steps que
 * fazem lookup (`kommo.findLeadByPhone`) ou em qualquer step que
 * carregue `result.leadId`. Retorna null se a execução não amarrou
 * a um lead (ex: teste no playground sem Kommo).
 *
 * Usado pelas telas Dashboard e Execuções do perfil Agente Inscrição
 * para filtrar execuções cujo lead está em INSCRIÇÃO/AGUARDANDO
 * PAGAMENTO.
 */
export function getExecutionLeadId(exec) {
  const fromUsage = Number(exec?.usage?.lead_id)
  if (Number.isFinite(fromUsage) && fromUsage > 0) return fromUsage
  const steps = Array.isArray(exec?.steps) ? exec.steps : []
  for (const s of steps) {
    const candidate = s?.result?.leadId ?? s?.leadId ?? null
    const n = Number(candidate)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

export function buildFunnelUrl(kommoScope) {
  if (!kommoScope || !Array.isArray(kommoScope.statusIds) || kommoScope.statusIds.length === 0) {
    return '/api/scheduler/funnel'
  }
  const params = new URLSearchParams()
  params.set('statusIds', kommoScope.statusIds.join(','))
  if (kommoScope.pipelineId) params.set('pipelineId', String(kommoScope.pipelineId))
  return `/api/scheduler/funnel?${params.toString()}`
}

export async function fetchScopedFunnel(kommoScope, { signal } = {}) {
  try {
    const r = await fetch(buildFunnelUrl(kommoScope), { signal })
    if (!r.ok) {
      return { ok: false, status: r.status, error: `HTTP ${r.status}`, leads: [], leadIds: null }
    }
    const j = await r.json()
    const leads = Array.isArray(j?.leads) ? j.leads : []
    const leadIds = new Set(leads.map((l) => Number(l.leadId)).filter((n) => Number.isFinite(n) && n > 0))
    return { ok: true, leads, leadIds, kommoOk: j?.kommoOk !== false, raw: j }
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, aborted: true, leadIds: null }
    return { ok: false, error: e?.message || 'fetch falhou', leadIds: null }
  }
}

/**
 * Hook: carrega os leadIds do funil do escopo dado. Quando `kommoScope`
 * é null/undefined, devolve `leadIds = null` (componente entende como
 * "sem filtro de escopo aplicar"). Recarrega quando o `kommoScope`
 * muda (compara pelos statusIds serializados).
 *
 * Devolve também `mode`:
 *  - 'include' (default) → componente deve manter SÓ leads em leadIds
 *  - 'exclude'           → componente deve manter leads que NÃO estão
 *                          em leadIds (perfil Atendimento usa pra
 *                          excluir leads em INSCRIÇÃO/PAGAMENTO)
 */
export function useScopedLeadIds(kommoScope) {
  const [state, setState] = useState({ loading: false, leadIds: null, error: null, kommoOk: true })

  const scopeKey = kommoScope?.statusIds
    ? `${kommoScope.pipelineId || ''}:${kommoScope.statusIds.join(',')}`
    : null

  useEffect(() => {
    if (!kommoScope) {
      setState({ loading: false, leadIds: null, error: null, kommoOk: true })
      return undefined
    }
    let alive = true
    const controller = new AbortController()
    setState((prev) => ({ ...prev, loading: true, error: null }))
    fetchScopedFunnel(kommoScope, { signal: controller.signal }).then((res) => {
      if (!alive) return
      setState({
        loading: false,
        leadIds: res.leadIds,
        error: res.ok ? null : (res.error || null),
        kommoOk: res.kommoOk !== false,
      })
    })
    return () => {
      alive = false
      controller.abort()
    }
  }, [scopeKey, kommoScope])

  return { ...state, mode: kommoScope?.mode || 'include' }
}

/**
 * Decide se um leadId casa com o escopo carregado. Quando `leadIds` é
 * null (escopo desligado ou ainda carregando) devolve `true` (passa
 * tudo, best-effort).
 *
 * Para itens sem leadId (ex: execução de playground sem lookup Kommo):
 *  - mode 'include' → NÃO passa (não dá pra confirmar que pertence ao escopo)
 *  - mode 'exclude' → passa (não está nos status excluídos)
 *
 * Use a função `passWhenMissing` pra controlar essa heurística por
 * componente, se precisar.
 */
export function leadMatchesScope(leadId, scopedState, { passWhenMissing } = {}) {
  if (!scopedState?.leadIds) return true
  const n = Number(leadId)
  if (!Number.isFinite(n) || n <= 0) {
    if (typeof passWhenMissing === 'boolean') return passWhenMissing
    return scopedState.mode === 'exclude'
  }
  const inSet = scopedState.leadIds.has(n)
  return scopedState.mode === 'exclude' ? !inSet : inSet
}
