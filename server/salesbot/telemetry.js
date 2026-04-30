/**
 * Persistência de execuções do salesbot na tabela `salesbot_execucoes`
 * (Supabase). Schema esperado (criar antes via SQL):
 *
 *   create table salesbot_execucoes (
 *     id text primary key,
 *     created_at timestamptz not null default now(),
 *     lead_id bigint,
 *     curso_original text,
 *     curso_corrigido text,
 *     curso_busca text,
 *     encontrado boolean,
 *     model text,
 *     duration_ms integer,
 *     error text,
 *     -- payload completo (steps, usage, aiMeta, rowCurso) em jsonb pra
 *     -- visualizar no detalhe sem precisar de coluna por campo.
 *     payload jsonb
 *   );
 *
 *   create index salesbot_execucoes_created_idx on salesbot_execucoes (created_at desc);
 *   create index salesbot_execucoes_lead_idx on salesbot_execucoes (lead_id);
 */

function getConfig(env) {
  return {
    url: env.SUPABASE_URL || env.VITE_SUPABASE_URL || '',
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
  }
}

export async function saveSalesbotExecution(env, exec) {
  const cfg = getConfig(env)
  if (!cfg.url || !cfg.key) return { ok: false, error: 'SUPABASE_NOT_CONFIGURED' }

  const row = {
    id: exec.executionId,
    created_at: exec.timestamp || new Date().toISOString(),
    lead_id: exec.leadId ?? null,
    curso_original: exec.cursoOriginal ?? null,
    curso_corrigido: exec.cursoCorrigido ?? null,
    curso_busca: exec.cursoBusca ?? null,
    encontrado: !!exec.encontrado,
    model: exec.model ?? null,
    duration_ms: exec.durationMs ?? 0,
    error: exec.error ?? null,
    payload: {
      steps: exec.steps || [],
      usage: exec.usage || null,
      aiMeta: exec.aiMeta || null,
      rowCurso: exec.rowCurso || null,
      grauOriginal: exec.grauOriginal ?? null,
    },
  }
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/salesbot_execucoes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        Prefer: 'return=minimal,resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: text.slice(0, 300) }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
