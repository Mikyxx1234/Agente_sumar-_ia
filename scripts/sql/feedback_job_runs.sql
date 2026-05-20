-- Job de feedback comercial (mensagens_atendimento_comercial).
-- Rode no SQL Editor do Supabase (projeto feedback / mesmo de SUPABASE_URL_FEEDBACK).

CREATE TABLE IF NOT EXISTS public.feedback_job_runs (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  trigger text,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_messages_fetched integer DEFAULT 0,
  total_segments integer DEFAULT 0,
  feedbacks_inserted integer DEFAULT 0,
  feedbacks_updated integer DEFAULT 0,
  pendentes_saved integer DEFAULT 0,
  ai_calls integer DEFAULT 0,
  prompt_tokens integer DEFAULT 0,
  completion_tokens integer DEFAULT 0,
  total_tokens integer DEFAULT 0,
  model text,
  duration_ms integer,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_feedback_job_runs_started_at
  ON public.feedback_job_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_job_runs_status_running
  ON public.feedback_job_runs (status)
  WHERE status = 'running';

COMMENT ON TABLE public.feedback_job_runs IS
  'Execuções do cron de feedback comercial (lock por hora UTC, status running/success/error).';
