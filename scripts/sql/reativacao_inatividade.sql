-- Colunas para controle de reativação por inatividade (dados_cliente / dados_cliente_sum).
-- Rode no SQL Editor do Supabase se ainda não existirem.

ALTER TABLE public.dados_cliente
  ADD COLUMN IF NOT EXISTS reativacao_ping_at timestamptz,
  ADD COLUMN IF NOT EXISTS reativacao_moved_at timestamptz;

-- Se usar tabela com sufixo _sum:
-- ALTER TABLE public.dados_cliente_sum
--   ADD COLUMN IF NOT EXISTS reativacao_ping_at timestamptz,
--   ADD COLUMN IF NOT EXISTS reativacao_moved_at timestamptz;
