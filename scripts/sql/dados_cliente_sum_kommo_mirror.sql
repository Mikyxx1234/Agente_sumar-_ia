-- Plano_Inscricao_CardKommo — espelhamento dos campos do card Kommo
-- em dados_cliente_sum, mais colunas já referenciadas pelo código que
-- não existiam na tabela (silent fail).
--
-- Aplicar em produção: ver scripts/apply-sql-rest.mjs ou colar no
-- editor SQL do Supabase.

-- Colunas já usadas pelo código (sem existir → PostgREST retornava 400
-- e a função engolia o erro).
ALTER TABLE dados_cliente_sum
  ADD COLUMN IF NOT EXISTS id_lead bigint,
  ADD COLUMN IF NOT EXISTS teste_AB text;

-- Estado de inscrição.
ALTER TABLE dados_cliente_sum
  ADD COLUMN IF NOT EXISTS polo_inscricao_escolhido text,
  ADD COLUMN IF NOT EXISTS captacao_unidade text;

-- Espelho do card Kommo (origem dos dados de inscrição).
ALTER TABLE dados_cliente_sum
  ADD COLUMN IF NOT EXISTS kommo_nome text,
  ADD COLUMN IF NOT EXISTS kommo_cpf text,
  ADD COLUMN IF NOT EXISTS kommo_email text,
  ADD COLUMN IF NOT EXISTS kommo_data_nasc text,
  ADD COLUMN IF NOT EXISTS kommo_curso text,
  ADD COLUMN IF NOT EXISTS kommo_polo text,
  ADD COLUMN IF NOT EXISTS kommo_modalidade text,
  ADD COLUMN IF NOT EXISTS kommo_status_inscricao text,
  ADD COLUMN IF NOT EXISTS kommo_sync_at timestamptz;

-- Índice para lookups por id_lead (sched + diag).
CREATE INDEX IF NOT EXISTS idx_dados_cliente_sum_id_lead
  ON dados_cliente_sum (id_lead);
