-- ╔══════════════════════════════════════════════════════════════════╗
-- ║   FAQ — entrada nova em documents_perguntas                      ║
-- ║                                                                  ║
-- ║   Modalidade EAD x provas presenciais no polo                    ║
-- ║                                                                  ║
-- ║   Contexto: o curso é EAD na maior parte (aulas e atividades),   ║
-- ║   mas algumas avaliações (provas) precisam ser feitas no polo    ║
-- ║   onde o aluno se matriculou. Quantidade exata varia.            ║
-- ║                                                                  ║
-- ║   Rodar no SQL Editor do Supabase. Embedding fica NULL — depois  ║
-- ║   clica em "Reindexar FAQ" no painel "Execuções IA" pra gerar.   ║
-- ╚══════════════════════════════════════════════════════════════════╝

insert into public.documents_perguntas (content, metadata)
values
  (
    $$Pergunta: O curso é 100% EAD? É totalmente EAD? É todo online? Posso fazer tudo de casa? Tem aula presencial? Tem encontro presencial? Tem prova presencial? Tem avaliação presencial? Onde faço as provas? Preciso ir ao polo? Em quais momentos vou precisar ir presencial? Tem alguma atividade presencial? O EAD é totalmente a distância? Tem que ir presencial em algum momento? A prova é online?
Resposta: O curso é na modalidade EAD: aulas, conteúdos e a maior parte das atividades são *100% online*, no seu próprio ritmo, pelo nosso Ambiente Virtual de Aprendizagem (AVA). 💻📚

A *única* parte presencial são algumas *avaliações* (provas) ao longo do curso, que precisam ser realizadas no *polo de apoio onde você se matriculou*. É uma exigência acadêmica que vale para todo curso EAD reconhecido pelo MEC, justamente para garantir a validade oficial da sua nota e do seu diploma.

A quantidade exata de provas presenciais e as datas variam conforme o calendário acadêmico do seu curso, e a equipe acadêmica avisa com antecedência para você se programar. 📅

No dia a dia, você mantém toda a flexibilidade do online — só vai ao polo nessas avaliações pontuais.

👉 Posso te ajudar a confirmar qual é o polo mais próximo da sua região para você ter essa referência?$$,
    jsonb_build_object('tipo', 'ead_provas_presenciais', 'origem', 'manual')
  );

-- Auditoria opcional:
-- select id, left(content, 80) as preview,
--        metadata->>'tipo' as tipo,
--        embedding is null as embedding_pendente
-- from public.documents_perguntas
-- where metadata->>'tipo' = 'ead_provas_presenciais'
-- order by id desc;
