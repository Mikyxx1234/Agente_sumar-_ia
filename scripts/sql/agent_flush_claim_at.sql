-- Coluna opcional para claim de flush entre réplicas (sem Redis).
-- Rode no SQL Editor do Supabase do projeto da IA.

ALTER TABLE public.dados_cliente_sum
  ADD COLUMN IF NOT EXISTS agent_flush_claim_at timestamptz;
