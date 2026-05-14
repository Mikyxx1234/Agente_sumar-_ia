-- ╔════════════════════════════════════════════════════════════════════╗
-- ║   ESTÁGIO — atualizar metadata.estagio em documents (graduação)    ║
-- ║                                                                    ║
-- ║   Usa jsonb_set pra mesclar { estagio: {...} } no metadata sem     ║
-- ║   perder os outros campos (grade_do_curso etc.).                   ║
-- ║                                                                    ║
-- ║   Estrutura esperada:                                              ║
-- ║                                                                    ║
-- ║   Curso COM estágio:                                               ║
-- ║     {                                                              ║
-- ║       "tem": true,                                                 ║
-- ║       "quantidade": 6,                                             ║
-- ║       "carga_total_horas": 800,                                    ║
-- ║       "detalhe": "Estágio Supervisionado em Farmácia I (20h)..."   ║
-- ║     }                                                              ║
-- ║                                                                    ║
-- ║   Curso SEM estágio:                                               ║
-- ║     { "tem": false }                                               ║
-- ║                                                                    ║
-- ║   Cursos sem o campo "estagio" no metadata: a IA segue a Rule 18   ║
-- ║   e chama distribuir_humano (NÃO afirma nada por conta própria).   ║
-- ║                                                                    ║
-- ║   Rodar no SQL Editor do Supabase. Após preencher, NÃO precisa     ║
-- ║   reindexar embeddings — o marcador é injetado em runtime pela     ║
-- ║   tool buscar_informacoes.                                         ║
-- ╚════════════════════════════════════════════════════════════════════╝

-- ── Farmácia (TEM estágio) ──
update public.documents
set metadata = jsonb_set(
  coalesce(metadata, '{}'::jsonb),
  '{estagio}',
  jsonb_build_object(
    'tem', true,
    'quantidade', 6,
    'carga_total_horas', 800,
    'detalhe', 'Estágio Supervisionado em Farmácia I (20h), II (20h), III (40h), IV (240h), V (240h), VI (240h)'
  ),
  true
)
where content ilike '%farm%cia%';  -- AJUSTE o filtro pra pegar APENAS o curso correto

-- ── Cibersegurança (NÃO tem estágio) ──
update public.documents
set metadata = jsonb_set(
  coalesce(metadata, '{}'::jsonb),
  '{estagio}',
  jsonb_build_object('tem', false),
  true
)
where content ilike '%cibersegur%';

-- ── Template pra outros cursos ──
-- Duplique um dos blocos acima e ajuste:
--   1. O filtro WHERE (use ilike com palavra-chave do curso, confira no SELECT antes)
--   2. Os campos do jsonb_build_object conforme o curso ter ou não estágio
--
-- IMPORTANTE: cheque o filtro ANTES com:
--   select id, left(content, 100) as preview, metadata->'estagio' as estagio_atual
--   from public.documents
--   where content ilike '%seu_filtro%';
-- Se aparecer mais de um curso ou curso errado, refine o filtro.

-- ── Auditoria geral ──
-- select id,
--        left(content, 80) as preview,
--        metadata->'estagio'->>'tem' as tem,
--        metadata->'estagio'->>'quantidade' as qtd,
--        metadata->'estagio'->>'carga_total_horas' as carga
-- from public.documents
-- where metadata ? 'estagio'
-- order by id;

-- ── Cursos AINDA sem o campo (pra você priorizar o preenchimento) ──
-- select id, left(content, 100) as preview
-- from public.documents
-- where not (metadata ? 'estagio')
-- order by id;
