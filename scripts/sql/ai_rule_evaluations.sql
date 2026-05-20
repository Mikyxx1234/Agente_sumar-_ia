-- Feedback IA — avaliações automáticas da IA contra as Regras 1-22.
-- Rode uma vez no SQL Editor do Supabase principal (SUPABASE_URL).

CREATE TABLE IF NOT EXISTS public.ai_rule_evaluations (
  id              bigserial PRIMARY KEY,
  lead_id         text,
  contact_id      text,
  telefone        text,

  -- Identifica de forma única uma "rodada de avaliação" da conversa.
  -- Quando o lead sai/volta do funil sem novas mensagens, a chave bate
  -- e o INSERT é descartado (idempotência).
  conversation_key text NOT NULL UNIQUE,

  -- Último user_message avaliado (created_at em ISO). Usado pra mostrar
  -- "Lead #X há Y minutos" na UI.
  last_message_at  timestamptz,
  turns_count      int DEFAULT 0,

  -- Resultado.
  verdict text NOT NULL CHECK (verdict IN ('APROVADO', 'PARCIAL', 'REPROVADO')),
  score   numeric(3,1) CHECK (score >= 0 AND score <= 10),

  -- jsonb com array de { rule_id, ok, severity, evidence, suggestion }.
  -- Um item por regra avaliada (idealmente 1-22).
  per_rule  jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Sugestão consolidada de mudança no prompt (texto livre, vinda do
  -- avaliador). Em Fase 1 é só leitura. Fase 2 aplica via aprovação.
  suggestion_text   text,
  suggested_rule_id int,
  suggested_new_body text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),

  -- Telemetria do avaliador.
  evaluator_model    text,
  evaluator_prompt_tokens     int,
  evaluator_completion_tokens int,
  evaluator_total_tokens      int,
  evaluator_duration_ms       int,

  -- Trigger: 'funnel_exit' (automático), 'manual', 'cron' (futuro).
  trigger text NOT NULL DEFAULT 'funnel_exit',

  -- Erro de execução (quando a chamada OpenAI falha).
  error text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_rule_eval_created
  ON public.ai_rule_evaluations (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_rule_eval_lead
  ON public.ai_rule_evaluations (lead_id);

CREATE INDEX IF NOT EXISTS idx_ai_rule_eval_verdict
  ON public.ai_rule_evaluations (verdict);

CREATE INDEX IF NOT EXISTS idx_ai_rule_eval_status
  ON public.ai_rule_evaluations (status);

COMMENT ON TABLE  public.ai_rule_evaluations IS
  'Avaliação automática da IA contra Regras 1-22 (server/ai/promptsLoader.js). Disparado quando lead sai do funil monitorado pelo agentScheduler.';

COMMENT ON COLUMN public.ai_rule_evaluations.conversation_key IS
  'Chave estável "{lead_id}:{last_message_at_iso}" — evita reavaliar mesma conversa.';

COMMENT ON COLUMN public.ai_rule_evaluations.per_rule IS
  'Array jsonb [{rule_id:int, ok:bool, severity:"low|medium|high", evidence:string, suggestion?:string}].';
