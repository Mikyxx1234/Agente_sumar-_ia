-- Dashboard metrics via RPC (agregação no Postgres — 1 request em vez de paginar mensagens_ia).
-- Aplicar: node --env-file=.env scripts/ensureDashboardMetricsRpc.mjs

CREATE INDEX IF NOT EXISTS idx_mensagens_ia_created_at ON public.mensagens_ia (created_at);

-- USD/1M tokens (espelha src/lib/openaiPricing.js) × 5.7 BRL
CREATE OR REPLACE FUNCTION public.openai_cost_brl(
  p_model text,
  p_prompt bigint,
  p_completion bigint
) RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (
    (COALESCE(p_prompt, 0)::numeric / 1000000.0) * (
      CASE COALESCE(NULLIF(trim(p_model), ''), 'gpt-4o-mini')
        WHEN 'gpt-4.1-nano' THEN 0.1
        WHEN 'gpt-4.1-mini' THEN 0.4
        WHEN 'gpt-4.1' THEN 2.0
        WHEN 'gpt-4o-mini' THEN 0.15
        WHEN 'gpt-4o' THEN 2.5
        WHEN 'gpt-5' THEN 1.25
        WHEN 'gpt-5-mini' THEN 0.25
        WHEN 'gpt-5-nano' THEN 0.05
        WHEN 'text-embedding-3-small' THEN 0.02
        WHEN 'text-embedding-3-large' THEN 0.13
        WHEN 'gemini-1.5-flash' THEN 0.075
        WHEN 'gemini-2.0-flash' THEN 0.1
        WHEN 'gemini-2.5-flash' THEN 0.3
        WHEN 'gemini-2.5-pro' THEN 1.25
        ELSE 0.15
      END
    )
    + (COALESCE(p_completion, 0)::numeric / 1000000.0) * (
      CASE COALESCE(NULLIF(trim(p_model), ''), 'gpt-4o-mini')
        WHEN 'gpt-4.1-nano' THEN 0.4
        WHEN 'gpt-4.1-mini' THEN 1.6
        WHEN 'gpt-4.1' THEN 8.0
        WHEN 'gpt-4o-mini' THEN 0.6
        WHEN 'gpt-4o' THEN 10.0
        WHEN 'gpt-5' THEN 10.0
        WHEN 'gpt-5-mini' THEN 2.0
        WHEN 'gpt-5-nano' THEN 0.4
        WHEN 'text-embedding-3-small' THEN 0.0
        WHEN 'text-embedding-3-large' THEN 0.0
        WHEN 'gemini-1.5-flash' THEN 0.3
        WHEN 'gemini-2.0-flash' THEN 0.4
        WHEN 'gemini-2.5-flash' THEN 2.5
        WHEN 'gemini-2.5-pro' THEN 10.0
        ELSE 0.6
      END
    )
  ) * 5.7;
$$;

-- Backfill usage.whatsapp_sent a partir de steps (idempotente)
UPDATE public.mensagens_ia AS m
SET usage = m.usage || jsonb_build_object('whatsapp_sent', sub.sent)
FROM (
  SELECT mi.id,
    MAX((s->'result'->>'sent')::int) AS sent
  FROM public.mensagens_ia mi
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(mi.steps, '[]'::jsonb)) AS s
  WHERE s->>'tool' = 'whatsapp.sendMessageWithNote'
    AND COALESCE(s->'result'->>'ok', 'false') = 'true'
    AND COALESCE((s->'result'->>'sent')::int, 0) > 0
    AND (mi.usage->>'whatsapp_sent') IS NULL
  GROUP BY mi.id
) AS sub
WHERE m.id = sub.id;

CREATE OR REPLACE FUNCTION public.dashboard_metrics(
  p_start timestamptz,
  p_end timestamptz
) RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH base AS (
    SELECT
      id,
      created_at,
      model,
      tool_calls,
      error,
      total_duration_ms,
      usage
    FROM public.mensagens_ia
    WHERE created_at >= p_start
      AND created_at <= p_end
  ),
  totals AS (
    SELECT
      count(*)::int AS messages_count,
      coalesce(sum((usage->>'total_tokens')::bigint), 0)::bigint AS tokens,
      count(*) FILTER (WHERE error IS NOT NULL AND nullif(trim(error), '') IS NOT NULL)::int AS errors_count,
      coalesce(sum(total_duration_ms), 0)::bigint AS duration_sum,
      count(*) FILTER (WHERE coalesce((usage->>'whatsapp_sent')::int, 0) > 0)::int AS whatsapp_sent_executions,
      coalesce(sum((usage->>'whatsapp_sent')::int) FILTER (WHERE coalesce((usage->>'whatsapp_sent')::int, 0) > 0), 0)::int AS whatsapp_parts_count
    FROM base
  ),
  by_day AS (
    SELECT
      to_char((created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS day_key,
      count(*)::int AS exec_count,
      count(*) FILTER (WHERE coalesce((usage->>'whatsapp_sent')::int, 0) > 0)::int AS wa_count
    FROM base
    GROUP BY 1
    ORDER BY 1
  ),
  tools AS (
    SELECT
      coalesce(tc->>'tool', 'unknown') AS tool_name,
      count(*)::int AS cnt
    FROM base
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tool_calls, '[]'::jsonb)) AS tc
    GROUP BY 1
    ORDER BY 2 DESC
  ),
  cost_orch AS (
    SELECT coalesce(sum(public.openai_cost_brl(
      model,
      coalesce((usage->>'prompt_tokens')::bigint, (usage->>'input_tokens')::bigint, 0),
      coalesce((usage->>'completion_tokens')::bigint, (usage->>'output_tokens')::bigint, 0)
    )), 0)::numeric AS v
    FROM base
  ),
  cost_rewrite AS (
    SELECT coalesce(sum(public.openai_cost_brl(
      u->>'model',
      coalesce((u->'usage'->>'prompt_tokens')::bigint, 0),
      coalesce((u->'usage'->>'completion_tokens')::bigint, 0)
    )), 0)::numeric AS v
    FROM base
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(usage->'_meta'->'queryRewriteUsage', '[]'::jsonb)) AS u
  ),
  cost_emb AS (
    SELECT coalesce(sum(public.openai_cost_brl(
      u->>'model',
      coalesce((u->'usage'->>'prompt_tokens')::bigint, 0),
      coalesce((u->'usage'->>'completion_tokens')::bigint, 0)
    )), 0)::numeric AS v
    FROM base
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(usage->'_meta'->'embeddingsUsage', '[]'::jsonb)) AS u
  ),
  cost_aux AS (
    SELECT coalesce(sum(public.openai_cost_brl(
      u->>'model',
      coalesce((u->'usage'->>'prompt_tokens')::bigint, 0),
      coalesce((u->'usage'->>'completion_tokens')::bigint, 0)
    )), 0)::numeric AS v
    FROM base
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(usage->'_meta'->'toolUsage', '[]'::jsonb)) AS u
  ),
  cost_scope AS (
    SELECT coalesce(sum(public.openai_cost_brl(
      u->>'model',
      coalesce((u->'usage'->>'prompt_tokens')::bigint, 0),
      coalesce((u->'usage'->>'completion_tokens')::bigint, 0)
    )), 0)::numeric AS v
    FROM base
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(usage->'_meta'->'scopeClassifierUsage', '[]'::jsonb)) AS u
  )
  SELECT jsonb_build_object(
    'messagesCount', t.messages_count,
    'tokens', t.tokens,
    'errorsCount', t.errors_count,
    'durationSum', t.duration_sum,
    'whatsappSentExecutions', t.whatsapp_sent_executions,
    'whatsappPartsCount', t.whatsapp_parts_count,
    'fetchedTotal', t.messages_count,
    'chartByDay', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'dayKey', d.day_key,
        'executions', d.exec_count,
        'whatsapp', d.wa_count
      ) ORDER BY d.day_key)
      FROM by_day d
    ), '[]'::jsonb),
    'toolsRaw', coalesce((
      SELECT jsonb_agg(jsonb_build_object('tool', tool_name, 'count', cnt) ORDER BY cnt DESC)
      FROM tools
    ), '[]'::jsonb),
    'costOrchestrator', (SELECT v FROM cost_orch),
    'costRewrite', (SELECT v FROM cost_rewrite),
    'costEmbeddings', (SELECT v FROM cost_emb),
    'costAuxTools', (SELECT v FROM cost_aux) + (SELECT v FROM cost_scope)
  )
  FROM totals t;
$$;

GRANT EXECUTE ON FUNCTION public.dashboard_metrics(timestamptz, timestamptz) TO anon, authenticated, service_role;
