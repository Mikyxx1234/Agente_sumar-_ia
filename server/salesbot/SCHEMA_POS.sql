-- ╔══════════════════════════════════════════════════════════════════╗
-- ║   SALESBOT PÓS — tudo numa tabela só (cursos_salesbot_pos_nome)  ║
-- ║                                                                  ║
-- ║   Rodar UMA vez no SQL Editor do Supabase (BANCO - AGENTE        ║
-- ║   COMERCIAL). É idempotente: pode rodar de novo pra repopular.   ║
-- ║                                                                  ║
-- ║   O que esse arquivo faz:                                        ║
-- ║     1. Apaga cursos_salesbot_pos (tabela auxiliar não usada)     ║
-- ║     2. Garante a estrutura de cursos_salesbot_pos_nome           ║
-- ║     3. Tira FK e desabilita RLS (pra você ver os dados na UI)    ║
-- ║     4. Recria a RPC de match (busca vetorial)                    ║
-- ║     5. Lê documents_precos, filtra pós, deduplica e popula       ║
-- ║        cursos_salesbot_pos_nome (content + metadata)             ║
-- ║     6. Embedding fica NULL — gera depois com:                    ║
-- ║        curl -X POST https://<host>/api/salesbot/reindex-pos      ║
-- ╚══════════════════════════════════════════════════════════════════╝


-- 1) Apaga a tabela auxiliar (FK em cursos_salesbot_pos_nome cai junto via cascade)
drop table if exists public.cursos_salesbot_pos cascade;

-- 2) Garante a tabela vetorial certinha
create extension if not exists vector;

create table if not exists public.cursos_salesbot_pos_nome (
  id bigserial primary key,
  curso_id bigint,
  content text,
  metadata jsonb,
  embedding vector(1536)
);

-- Solta NOT NULL e qualquer FK que tenha sobrado de versões anteriores
alter table public.cursos_salesbot_pos_nome
  alter column curso_id drop not null;

do $$
declare
  cn text;
begin
  for cn in
    select constraint_name
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'cursos_salesbot_pos_nome'
      and constraint_type = 'FOREIGN KEY'
  loop
    execute format(
      'alter table public.cursos_salesbot_pos_nome drop constraint %I',
      cn
    );
  end loop;
end $$;

-- 3) Desabilita RLS (era o motivo do "Select queries may return 0 results")
alter table public.cursos_salesbot_pos_nome disable row level security;

-- 4) Index ANN pra busca rápida (cosine similarity)
create index if not exists cursos_salesbot_pos_nome_emb_idx
  on public.cursos_salesbot_pos_nome
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 5) RPC do match (vector search) — chamada por server/salesbot/csvSearch.js
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


-- ╔══════════════════════════════════════════════════════════════════╗
-- ║                  6) Popula a partir de documents_precos          ║
-- ╚══════════════════════════════════════════════════════════════════╝
--
-- Estrutura observada na documents_precos:
--   metadata (jsonb) tem chave "Metadata" (M MAIÚSCULO — PascalCase) que
--   é uma STRING JSON serializada (formato LangChain Blob) com os
--   campos reais: tipo, curso, valor, tempo, modalidade (lowercase).
--   ⚠ Em jsonb as chaves são case-sensitive: 'metadata' ≠ 'Metadata'.
--
-- Filtro: tipo ~* 'p[óo]s' — pega "pós-graduação" e "pos-graduacao",
-- com ou sem acento, case-insensitive. NÃO pega "graduação".
--
-- Dedup: pra cada (curso, duração), mantém só a linha de MENOR preço.
-- Resolve "9 meses R$170 + 9 meses R$161" → fica só R$161.
--
-- Ordem dos pacotes: por duração crescente. duracao_1 < duracao_2 por
-- construção (nunca duracao_1 = duracao_2).

truncate table public.cursos_salesbot_pos_nome restart identity cascade;

with parsed as (
  select
    btrim(((metadata->>'Metadata')::jsonb)->>'curso')               as curso_nome,
    coalesce(((metadata->>'Metadata')::jsonb)->>'modalidade', 'EAD') as modalidade,
    btrim(((metadata->>'Metadata')::jsonb)->>'tempo')               as tempo,
    btrim(((metadata->>'Metadata')::jsonb)->>'valor')               as valor,
    coalesce(((metadata->>'Metadata')::jsonb)->>'tipo', '')          as tipo
  from public.documents_precos
  where metadata ? 'Metadata'
),
pos_only as (
  select
    *,
    coalesce(
      nullif(regexp_replace(tempo, '\D+', '', 'g'), ''),
      '999'
    )::int as meses,
    nullif(
      regexp_replace(replace(valor, ',', '.'), '[^\d.]', '', 'g'),
      ''
    )::numeric as preco_num
  from parsed
  where curso_nome is not null and curso_nome <> ''
    and tempo is not null and tempo <> ''
    and valor is not null and valor <> ''
    and tipo ~* 'p[óo]s'
),
dedup as (
  select distinct on (lower(curso_nome), meses)
    curso_nome, modalidade, tempo, valor, meses, preco_num
  from pos_only
  order by lower(curso_nome), meses, preco_num asc nulls last
),
ranked as (
  select
    curso_nome, modalidade, tempo, valor, meses,
    row_number() over (
      partition by lower(curso_nome)
      order by meses asc
    ) as rn
  from dedup
),
agregado as (
  select
    curso_nome,
    max(modalidade) filter (where rn = 1) as modalidade,
    max(tempo)      filter (where rn = 1) as duracao_1,
    max(valor)      filter (where rn = 1) as preco_1,
    max(tempo)      filter (where rn = 2) as duracao_2,
    max(valor)      filter (where rn = 2) as preco_2,
    count(*)        as total_pacotes
  from ranked
  where rn <= 2
  group by curso_nome
)
insert into public.cursos_salesbot_pos_nome (content, metadata)
select
  curso_nome as content,
  jsonb_build_object(
    'tipo',       'pos-graduacao',
    'curso',      curso_nome,
    'modalidade', coalesce(modalidade, 'EAD'),
    'duracao_1',  duracao_1,
    'preco_1',    preco_1,
    'duracao_2',  duracao_2,
    'preco_2',    preco_2,
    'contagem',   total_pacotes::text
  ) as metadata
from agregado
order by curso_nome;


-- ╔══════════════════════════════════════════════════════════════════╗
-- ║                       AUDITORIA (descomenta)                     ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- select count(*) as total_cursos_pos from public.cursos_salesbot_pos_nome;

-- select count(*) as duracoes_iguais
-- from public.cursos_salesbot_pos_nome
-- where metadata->>'duracao_1' is not null
--   and metadata->>'duracao_2' is not null
--   and metadata->>'duracao_1' = metadata->>'duracao_2';

-- select content,
--        metadata->>'duracao_1' as d1, metadata->>'preco_1' as p1,
--        metadata->>'duracao_2' as d2, metadata->>'preco_2' as p2
-- from public.cursos_salesbot_pos_nome
-- where lower(content) like '%saúde pública%';

-- select content,
--        metadata->>'duracao_1' as d1, metadata->>'preco_1' as p1,
--        metadata->>'duracao_2' as d2, metadata->>'preco_2' as p2,
--        metadata->>'contagem'  as contagem
-- from public.cursos_salesbot_pos_nome
-- order by random()
-- limit 10;
