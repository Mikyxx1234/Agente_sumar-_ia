-- Treinamento de comportamento: avaliações das execuções do agente (dashboard).
-- Rode uma vez no SQL Editor do Supabase (projeto principal — SUPABASE_URL).

CREATE TABLE IF NOT EXISTS public.agent_training_feedback (
  execution_id text PRIMARY KEY,
  rating text NOT NULL CHECK (rating IN ('positive', 'negative')),
  suggestion text,
  user_message text,
  agent_response text,
  model text,
  telefone text,
  lead_id text,
  origem text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_training_feedback_rating
  ON public.agent_training_feedback (rating);

CREATE INDEX IF NOT EXISTS idx_agent_training_feedback_updated
  ON public.agent_training_feedback (updated_at DESC);

COMMENT ON TABLE public.agent_training_feedback IS
  'Feedback humano sobre respostas do agente (execuções EX-*). Positivo = reforço; negativo + suggestion = orientação para não repetir.';
