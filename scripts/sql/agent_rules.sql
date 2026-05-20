-- Feedback IA · Fase 2 — regras do agente versionadas em DB.
-- Rode no SQL Editor do Supabase principal (SUPABASE_URL), após
-- ai_rule_evaluations.sql. Seguro de re-rodar (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS public.agent_rules (
  id          int PRIMARY KEY CHECK (id BETWEEN 1 AND 99),
  version     int NOT NULL DEFAULT 1,
  title       text NOT NULL,
  body        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS public.agent_rule_versions (
  id          bigserial PRIMARY KEY,
  rule_id     int NOT NULL,
  version     int NOT NULL,
  body        text NOT NULL,
  source      text NOT NULL CHECK (source IN ('seed', 'patch_approved', 'rollback')),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text,
  source_evaluation_id bigint,
  UNIQUE (rule_id, version)
);

CREATE INDEX IF NOT EXISTS idx_arv_rule_id
  ON public.agent_rule_versions (rule_id, applied_at DESC);

COMMENT ON TABLE public.agent_rules IS
  'Regras 1-22 do override do agente. Versionadas via agent_rule_versions. Carregadas pelo promptsLoader com fallback hardcoded.';

COMMENT ON TABLE public.agent_rule_versions IS
  'Histórico imutável de cada versão de cada regra. INSERT-only.';
