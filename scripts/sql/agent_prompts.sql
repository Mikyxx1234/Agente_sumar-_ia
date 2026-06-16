-- Prompts do agente (nodes do APAGAR.txt) versionados em DB.
-- Permite editar pelo painel e o agente usar sem deploy (overlay sobre o
-- APAGAR.txt em promptsLoader, atras da flag AGENT_DB_OVERRIDES_ENABLED).
-- Rode no SQL Editor do Supabase principal (SUPABASE_URL). Seguro re-rodar.

CREATE TABLE IF NOT EXISTS public.agent_prompts (
  prompt_id   text PRIMARY KEY,
  node_name   text,
  node_type   text,
  body        text NOT NULL,
  version     int  NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS public.agent_prompt_versions (
  id          bigserial PRIMARY KEY,
  prompt_id   text NOT NULL,
  version     int  NOT NULL,
  body        text NOT NULL,
  source      text NOT NULL CHECK (source IN ('seed', 'edit', 'rollback')),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text,
  UNIQUE (prompt_id, version)
);

CREATE INDEX IF NOT EXISTS idx_apv_prompt_id
  ON public.agent_prompt_versions (prompt_id, applied_at DESC);

COMMENT ON TABLE public.agent_prompts IS
  'Prompts (systemMessage de cada node do APAGAR.txt) editaveis em runtime. Overlay aplicado pelo promptsLoader quando AGENT_DB_OVERRIDES_ENABLED=true. Fallback: APAGAR.txt saneado.';

COMMENT ON TABLE public.agent_prompt_versions IS
  'Historico imutavel de cada versao de cada prompt. INSERT-only.';
