-- Bootstrap obrigatório (rodar UMA VEZ no painel SQL do Supabase).
--
-- Cria a função `exec_sql` que permite ao script
-- `scripts/apply-sql-rest.mjs` aplicar DDL em migrações futuras via
-- REST (PostgREST). Sem essa função, a aplicação automática não
-- funciona e migrations precisam ser coladas no painel manualmente.
--
-- Onde aplicar: Supabase Studio → SQL Editor → Cole e execute.

create or replace function public.exec_sql(sql text)
returns void
language plpgsql
security definer
as $$
begin
  execute sql;
end;
$$;

grant execute on function public.exec_sql(text) to service_role;
