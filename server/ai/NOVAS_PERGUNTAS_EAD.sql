-- ╔══════════════════════════════════════════════════════════════════╗
-- ║   FAQ — entrada nova / atualizada em documents_perguntas         ║
-- ║                                                                  ║
-- ║   Modalidade EAD x provas presenciais no polo                    ║
-- ║                                                                  ║
-- ║   Contexto:                                                      ║
-- ║     - O curso é EAD na maior parte (aulas e atividades online).  ║
-- ║     - Algumas avaliações precisam ser feitas no polo onde o      ║
-- ║       aluno se matriculou.                                       ║
-- ║     - As provas presenciais começam APENAS EM 2027 — em 2026 o   ║
-- ║       curso segue 100% online.                                   ║
-- ║                                                                  ║
-- ║   Por que usamos um embedding placeholder (vetor zerado)?        ║
-- ║   A coluna `embedding` é NOT NULL. Inserimos com 1536 zeros e    ║
-- ║   marcamos `metadata.embedding_pendente = true`. O reindex (botão║
-- ║   "Reindexar FAQ" no painel de Execuções IA) processa essas      ║
-- ║   linhas, gera o embedding real e remove a flag.                 ║
-- ║                                                                  ║
-- ║   Idempotente: faz UPDATE se a entrada já existe, senão INSERT.  ║
-- ║   Pode rodar sem medo, mesmo que você já tenha rodado a versão   ║
-- ║   anterior do arquivo.                                           ║
-- ╚══════════════════════════════════════════════════════════════════╝

do $$
declare
  v_existing int;
  v_zero vector(1536) := array_fill(0::real, ARRAY[1536])::vector;
  v_content text := $CONTENT$Pergunta: O curso é 100% EAD? É totalmente EAD? É todo online? Posso fazer tudo de casa? Tem aula presencial? Tem encontro presencial? Tem prova presencial? Tem avaliação presencial? Onde faço as provas? Preciso ir ao polo? Em quais momentos vou precisar ir presencial? Tem alguma atividade presencial? O EAD é totalmente a distância? Tem que ir presencial em algum momento? A prova é online? A partir de quando começam as provas presenciais? Quando começa a parte presencial?
Resposta: O curso é na modalidade EAD: aulas, conteúdos e a maior parte das atividades são *100% online*, no seu próprio ritmo, pelo nosso Ambiente Virtual de Aprendizagem (AVA). 💻📚

A *única* parte presencial são algumas *avaliações* (provas) ao longo do curso, que precisam ser realizadas no *polo de apoio onde você se matriculou*. É uma exigência acadêmica que vale para todo curso EAD reconhecido pelo MEC, justamente para garantir a validade oficial da sua nota e do seu diploma.

📌 Importante: essas avaliações presenciais *só começam a partir de 2027*. Quem entra agora estuda *100% online* durante todo o primeiro período — e quando chegarem as provas presenciais, a equipe acadêmica avisa as datas com antecedência. 📅

No dia a dia, você mantém toda a flexibilidade do online — só vai ao polo nessas avaliações pontuais, lá na frente.

👉 Posso te ajudar a confirmar qual é o polo mais próximo da sua região para você já ter essa referência?$CONTENT$;
begin
  select count(*) into v_existing
  from public.documents_perguntas
  where metadata->>'tipo' = 'ead_provas_presenciais';

  if v_existing > 0 then
    update public.documents_perguntas
       set content   = v_content,
           embedding = v_zero,
           metadata  = coalesce(metadata, '{}'::jsonb)
                       || jsonb_build_object('embedding_pendente', true)
     where metadata->>'tipo' = 'ead_provas_presenciais';
    raise notice 'documents_perguntas: % linha(s) atualizada(s) (tipo=ead_provas_presenciais).', v_existing;
  else
    insert into public.documents_perguntas (content, metadata, embedding)
    values (
      v_content,
      jsonb_build_object(
        'tipo', 'ead_provas_presenciais',
        'origem', 'manual',
        'embedding_pendente', true
      ),
      v_zero
    );
    raise notice 'documents_perguntas: 1 linha inserida (tipo=ead_provas_presenciais).';
  end if;
end $$;

-- Auditoria opcional:
-- select id, left(content, 100) as preview,
--        metadata->>'tipo' as tipo,
--        (metadata->>'embedding_pendente')::boolean as pendente
-- from public.documents_perguntas
-- where metadata->>'tipo' = 'ead_provas_presenciais'
-- order by id desc;
