-- Tabela onde o backend grava cada execução do salesbot pesquisador.
-- Necessária pra que a aba "Execuções Salesbot" do painel mostre
-- histórico. Sem ela, o webhook ainda funciona (o lead é atualizado
-- normalmente), mas a página fica vazia.
--
-- Rodar UMA VEZ no SQL Editor do Supabase principal (projeto
-- "BANCO AGENTE COMERCIAL").

create table if not exists public.salesbot_execucoes (
  id text primary key,
  created_at timestamptz not null default now(),
  lead_id bigint,
  curso_original text,
  curso_corrigido text,
  curso_busca text,
  encontrado boolean,
  model text,
  duration_ms integer,
  error text,
  payload jsonb
);

create index if not exists salesbot_execucoes_created_idx
  on public.salesbot_execucoes (created_at desc);

create index if not exists salesbot_execucoes_lead_idx
  on public.salesbot_execucoes (lead_id);
