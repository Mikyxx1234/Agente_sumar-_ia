-- ╔══════════════════════════════════════════════════════════════════╗
-- ║   SALESBOT POS — schema (apenas DDL)                             ║
-- ║                                                                  ║
-- ║   Rodar UMA VEZ no SQL Editor do Supabase principal              ║
-- ║   (BANCO - AGENTE COMERCIAL).                                    ║
-- ║                                                                  ║
-- ║   Cria:                                                          ║
-- ║     - cursos_salesbot_pos (catálogo, vazio)                      ║
-- ║     - cursos_salesbot_pos_nome (vetorial, vazio)                 ║
-- ║     - match_cursos_salesbot_pos_nome (RPC)                       ║
-- ║                                                                  ║
-- ║   Depois, no painel "Execuções Salesbot":                        ║
-- ║     1. Clicar "Reconstruir catálogo pós" → popula                ║
-- ║        cursos_salesbot_pos a partir de documents_precos          ║
-- ║        (mesma fonte que a IA principal usa).                     ║
-- ║     2. Clicar "Reindexar pós" → gera os embeddings.              ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ───── pgvector ─────
create extension if not exists vector;

-- ───── Catálogo ─────
create table if not exists public.cursos_salesbot_pos (
  id bigserial primary key,
  "Curso" text not null,
  curso_sinonimo text,
  modalidade text default 'EAD',
  duracao_1 text,
  preco_1 text,
  duracao_2 text,
  preco_2 text,
  contagem text default '2',
  area text
);

create unique index if not exists cursos_salesbot_pos_curso_idx
  on public.cursos_salesbot_pos (lower("Curso"));

-- ───── Vetor pra busca semântica ─────
create table if not exists public.cursos_salesbot_pos_nome (
  id bigserial primary key,
  curso_id bigint references public.cursos_salesbot_pos(id) on delete cascade,
  content text,
  metadata jsonb,
  embedding vector(1536)
);

create index if not exists cursos_salesbot_pos_nome_curso_idx
  on public.cursos_salesbot_pos_nome (curso_id);

-- Index ANN pra busca rápida (cosine similarity).
create index if not exists cursos_salesbot_pos_nome_emb_idx
  on public.cursos_salesbot_pos_nome
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ───── RPC do match (espelha match_cursos_salesbot_nome) ─────
create or replace function public.match_cursos_salesbot_pos_nome(
  query_embedding vector(1536),
  match_count int default 5,
  filter jsonb default '{}'
)
returns table (
  id bigint,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    n.id,
    n.content,
    n.metadata,
    1 - (n.embedding <=> query_embedding) as similarity
  from public.cursos_salesbot_pos_nome n
  where n.metadata @> filter
  order by n.embedding <=> query_embedding asc
  limit match_count;
end;
$$;
