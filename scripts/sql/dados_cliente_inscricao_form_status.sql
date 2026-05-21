-- Faculdade Sumaré — colunas de fluxo inscrição / reativação em dados_cliente_sum
-- Rode no SQL Editor do Supabase (projeto tufvduiaybogfhgausqj) se PATCH retornar 400.

ALTER TABLE public.dados_cliente_sum
  ADD COLUMN IF NOT EXISTS inscricao_form_status text,
  ADD COLUMN IF NOT EXISTS inscricao_form_recebido_at timestamptz,
  ADD COLUMN IF NOT EXISTS reativacao_ping_at timestamptz,
  ADD COLUMN IF NOT EXISTS reativacao_moved_at timestamptz,
  ADD COLUMN IF NOT EXISTS captacao_candidato_id text,
  ADD COLUMN IF NOT EXISTS captacao_contrato_link text,
  ADD COLUMN IF NOT EXISTS captacao_contrato_link_at timestamptz,
  ADD COLUMN IF NOT EXISTS captacao_comprovante_at timestamptz;

COMMENT ON COLUMN public.dados_cliente_sum.inscricao_form_status IS
  'aguardando_form_sumar | aguardando_distribuicao_form | form_sumar_concluido | aguardando_aceite_contrato | comprovante_pagamento_recebido';
