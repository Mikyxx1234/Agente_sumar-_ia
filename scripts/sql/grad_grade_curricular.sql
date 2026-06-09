-- Grade curricular de graduação (RAG pgvector) — Faculdade Sumaré
-- Rode uma vez no SQL Editor do Supabase ou via scripts/ensureGradGradeCurricularTable.mjs

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.grad_grade_curricular (
  id bigint PRIMARY KEY,
  content text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  embedding vector(1536)
);

CREATE INDEX IF NOT EXISTS grad_grade_curricular_embedding_idx
  ON public.grad_grade_curricular
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS grad_grade_curricular_curso_mod_idx
  ON public.grad_grade_curricular ((metadata->>'curso_id'), (metadata->>'modalidade'));

CREATE OR REPLACE FUNCTION public.match_grad_grade_curricular(
  query_embedding vector(1536),
  match_count int DEFAULT 5,
  filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id bigint,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    g.id,
    g.content,
    g.metadata,
    (1 - (g.embedding <=> query_embedding))::float AS similarity
  FROM public.grad_grade_curricular g
  WHERE g.embedding IS NOT NULL
  ORDER BY g.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
