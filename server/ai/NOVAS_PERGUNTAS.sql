-- ╔══════════════════════════════════════════════════════════════════╗
-- ║   FAQ — duas novas entradas em documents_perguntas               ║
-- ║                                                                  ║
-- ║   1) Bolsa garantida durante todo o curso (reajuste de mensalidade)
-- ║   2) TCC — sempre distribuir pra atendente humano                 ║
-- ║                                                                  ║
-- ║   Rodar no SQL Editor do Supabase. Embeddings ficam NULL — depois ║
-- ║   clica em "Reindexar FAQ" no painel "Execuções IA" pra gerar.    ║
-- ╚══════════════════════════════════════════════════════════════════╝

insert into public.documents_perguntas (content, metadata)
values
  (
    $$Pergunta: O valor da mensalidade fica até o final do curso? Esse valor se mantém? A mensalidade aumenta? Tem reajuste durante o curso? O preço sobe? Vai mudar? Vai aumentar até eu terminar?
Resposta: A bolsa que te passei é garantida durante *todo o curso*, com reajustes anuais apenas para acompanhar a inflação.
Entrando agora, o primeiro reajuste só acontece a partir da *2ª rematrícula*, e mesmo assim é de apenas *8% a 12% ao ano*, um valor bem acessível.
👉 Vamos confirmar sua matrícula hoje para garantir esse benefício?$$,
    jsonb_build_object('tipo', 'mensalidade_reajuste', 'origem', 'manual')
  ),
  (
    $$Pergunta: É necessário apresentar TCC? Tem TCC no curso? É obrigatório fazer TCC? Tem monografia? Tem trabalho de conclusão de curso? Como funciona o TCC? Preciso fazer TCC?
Resposta: INSTRUÇÃO INTERNA PARA O AGENTE: A obrigatoriedade de TCC varia por curso (alguns exigem, outros não). Você NÃO deve responder diretamente sobre TCC. Chame a tool distribuir_humano (passando o telefone do Contexto) e diga ao cliente, em tom acolhedor, que um consultor entrará em contato em breve para esclarecer essa dúvida específica do curso dele.$$,
    jsonb_build_object('tipo', 'tcc_distribuir', 'origem', 'manual')
  );

-- Auditoria opcional:
-- select id, left(content, 80) as preview,
--        metadata->>'tipo' as tipo,
--        embedding is null as embedding_pendente
-- from public.documents_perguntas
-- where metadata->>'origem' = 'manual'
-- order by id desc;
