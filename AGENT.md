# Decisões arquiteturais — Agente Sumaré IA

Histórico das decisões estruturais do agente. Formato por entrada:

```
### [DATA] - [TÍTULO]
- Decisão
- Contexto
- Alternativas descartadas
- Impacto
```

---

### 2026-05-28 - Inscrição express via dados do card Kommo (Sumaré Comercial)

- **Decisão**
  - Quando o card Kommo já tem todos os campos `sum_*` preenchidos
    (`sum_Nome`, `sum_CPF`, `sum_Email`, `sum_Curso`, `sum_Polo`,
    `sum_Data_Nascimento`, `sum_Modalidade`), o agente **pula o Form
    Sumar** e cria a candidatura direto via API Sumaré. Implementado em
    [server/inscricaoKommoPreFilledFlow.js](server/inscricaoKommoPreFilledFlow.js)
    e plugado no `agentRunner.js` antes do `tryHandlePoloPreFormFlow`.
  - **UX `ux_confirma = express`**: sem etapa "confirma seus dados?" —
    aproveita o card como fonte de verdade.
  - **UX `ux_inscrito = criar_novo`**: mesmo com `sum_Status_Inscricao =
    "Inscrito"`, cria nova candidatura (decisão de negócio: API decide o
    que fazer com duplicação).
  - **UX `polo = confirma_polo`**: antes de criar a candidatura, agente
    pergunta ao lead "quer manter `<sum_Polo>` como polo?". Novo estado
    `aguardando_confirm_polo_kommo`. Lead pode confirmar ("sim", "isso",
    "manter"), declinar ("não", "trocar polo") ou citar outro polo direto.
  - **Campos obrigatórios `sim_obrigatorios`**: se faltar `sum_Data_Nascimento`
    OU `sum_Modalidade` no card, NÃO tenta express — cai no Form Sumar
    tradicional.
  - **Loop scheduler**: captação falhada (curso indisponível, dados
    inválidos) agora grava `inscricao_form_status = distribuir_consultor`
    (novo estado terminal). Antes, o pipeline pós-form deixava o lead em
    `aguardando_distribuicao_form` para sempre — o scheduler reprocessava
    a cada tick (caso CAIO SILVA #23608285).
  - **Espelhamento Kommo → Supabase**: módulo
    [server/kommoCardMirror.js](server/kommoCardMirror.js) grava o
    snapshot do card nas colunas `kommo_*` de `dados_cliente_sum` com
    TTL de 5 min (evita PATCH a cada turno).

- **Contexto**
  - Caso CAIO SILVA #23608285: card completo, mas agente perguntou polo,
    mandou Form Sumar e entrou em loop no scheduler quando a API Sumaré
    rejeitou "Pedagogia" (indisponível para inscrição automática). Lead
    sem resposta + scheduler queimando ciclos.
  - Vários canais comerciais da Sumaré já populam o card antes do lead
    chegar no WhatsApp — manter Form Sumar como única porta de entrada
    duplicava trabalho e introduzia pontos de falha.

- **Alternativas descartadas**
  - *Confirmar dados genérico ("Você é X, CPF Y? confirma?")*: aumenta
    fricção; trade-off de "dado errado no card" fica com o canal que
    populou o card (responsabilidade já existente).
  - *Polo `sim_pular` (não perguntar)*: rejeitado pelo negócio — o polo
    é informação que o lead pode ter mudado de ideia desde o cadastro
    inicial; vale uma confirmação rápida.
  - *Polo `sempre_pergunta` (ignora `sum_Polo`)*: ignorar a informação
    do card aumentaria atrito; melhor confirmar.
  - *Campos `nao_sei` (deixar API decidir)*: cria mais loops para
    `distribuir_consultor` em casos triviais que o card já indicava
    incompletos.
  - *Migration via REST direto*: PostgREST não aceita DDL puro; precisa
    da RPC `exec_sql`. Caminho híbrido: arquivo `.sql` versionado +
    aplicador via REST (com bootstrap manual UMA VEZ no painel
    Supabase). Arquivos em [scripts/sql/](scripts/sql/).

- **Impacto**
  - Lead com card completo: matrícula em 1-2 turnos (vs. 4-5 turnos via
    Form Sumar). Reduz drop-off durante o preenchimento.
  - Scheduler para de queimar ciclos em leads com curso indisponível.
  - Migration adiciona 10 colunas em `dados_cliente_sum` (`kommo_*`,
    `polo_inscricao_escolhido`, `captacao_unidade`, `id_lead`, `teste_AB`
    — essas 2 últimas já eram usadas pelo código mas inexistentes na
    tabela, silent fail).
  - Feature flag `INSCRICAO_KOMMO_CARD_EXPRESS_ENABLED=true` (default).
    Para desligar: `false` no env.
  - Pré-requisito manual: aplicar [scripts/sql/00_bootstrap_exec_sql.sql](scripts/sql/00_bootstrap_exec_sql.sql)
    no Supabase Studio (uma vez), depois `node scripts/apply-sql-rest.mjs
    scripts/sql/dados_cliente_sum_kommo_mirror.sql`. Sem isso o código
    continua funcionando (cai no Form Sumar), mas o fluxo express não
    ativa.

---

### 2026-05-27 - Link enviado ao candidato sempre na tela `/contrato` (ASSINAR CONTRATO)

- **Decisão**
  - `resolvePortalUrlForCandidato` em [server/sumareCaptacaoClient.js](server/sumareCaptacaoClient.js)
    passa a devolver **sempre** a URL `/vem-pra-sumare/vestibular/contrato?id=…`
    (tela "Termos de Contrato → Clique para abrir → Li e concordo → ASSINAR
    CONTRATO"), independentemente do `status` do candidato na API Sumaré.
  - O campo `phase` (`'contrato' | 'pagamento'`) é mantido apenas como
    telemetria — útil em logs/notas para entender em que fase a API estava,
    mas não muda a URL enviada.
  - O ponto de override do `extractUrlFromPayload` foi invertido: quando a
    API devolve uma URL `meioPagamento` no payload de aceite, ela é
    substituída pela URL `/contrato`.

- **Contexto**
  - Antes, quando o candidato voltava após já ter aceitado o contrato
    (`status="meioPagamento"`), o agente enviava direto o link
    `/meioPagamento?id=…`. Caso real lead #23841399 (notas 16:57 e 17:30).
  - Negócio prefere fluxo único: o candidato sempre cai na tela "ASSINAR
    CONTRATO", que **já redireciona** para pagamento quando o aceite está
    OK. UX mais previsível e instruções padronizadas ("acesse o link, leia
    e clique em ASSINAR CONTRATO").

- **Alternativas descartadas**
  - *Manter dois links*: aumentava bifurcação no prompt e nas mensagens —
    cada caso exigia copy diferente; já tínhamos relatos de candidatos
    "perdidos" ao receber `/meioPagamento` sem contexto.
  - *Adicionar flag de env (`SUMARE_PORTAL_ALWAYS_CONTRATO`)*: optei por
    fixar o comportamento direto, sem flag, porque é o caminho que o
    negócio quer em 100% dos casos.

- **Impacto**
  - Toda mensagem com link de contrato (captacaoInscricaoExistenteFlow,
    inscricaoAceitePagamentoFlow, matriculaCaptacaoPipeline) passa a usar
    `/contrato?id=…`.
  - Status persistido no Supabase (`captacao_contrato_link`) também passa
    a guardar a URL canônica.
  - Cobertura de testes: seção 9 em `scripts/test-inscricao-flow.mjs`.

### 2026-05-27 - Mirror obrigatório de `inscricao_form_status` a partir do reply do agente + fallback via notas Kommo

- **Decisão**
  - Adicionar **auto-sync de estado** em `server/inscricaoStateAutoSync.js`:
    sempre que o reply final do agente contiver texto canônico de transição
    (detectado por `assistantAskedPoloPreFormChoice`), gravar o
    `inscricao_form_status` correspondente no Supabase **antes** de enviar
    a mensagem ao lead. Idempotente; não rebaixa estados terminais/avançados
    (`aguardando_form_sumar`, `aguardando_distribuicao_form`,
    `aguardando_aceite_contrato`, `form_sumar_concluido`,
    `comprovante_pagamento_recebido`).
  - Adicionar **fallback via notas Kommo** em
    `tryHandlePoloPreFormFlow`: quando histórico está vazio e status é
    null, consultar as últimas 6 notas do lead no Kommo e, se alguma casar
    com `assistantAskedPoloPreFormChoice`, tratar como
    `aguardando_escolha_polo_pre_form`. Só ativa quando a mensagem do lead
    "parece polo" (`matchPoloFromUserMessage` retorna polo válido).
  - Adicionar **retry com backoff** em `appendChatMemory` (200ms, 600ms)
    para 408/425/429/5xx, reduzindo `n8n_chat_histories` vazio por falha
    transitória.
  - Adicionar **log estruturado** `INSCRICAO_CTX stage=… polo=… historyLen=…
    historySource=… lastAssistLen=… polo_signal_in_lastAssist=…` no
    `agentRunner` para tornar visível a causa quando o fluxo pára.

- **Contexto**
  - Caso real lead #23841399 ("William testest"): lead respondeu "5" após
    o agente perguntar polo, mas não houve resposta. Investigação mostrou
    `n8n_chat_histories` e `chat_messages_sum` ambos vazios para o
    telefone; `inscricao_form_status` = NULL no Supabase. Cronologia:
    `lead "matricula" → LLM responde com lista de polos (sem chamar tool)
    → status fica NULL → lead "5" → tryHandlePoloPreFormFlow encontra
    status=NULL e lastAssist="" → retorna null → mensagem cai no LLM sem
    contexto → silêncio.`
  - Diagnóstico confirmou que **TODAS** as notas do Kommo têm sufixo
    `- EX-…` (não há outro Salesbot externo conflitando). O problema é
    estrutural: depender do histórico para sustentar o estado quando o
    LLM responde diretamente, sem tool.

- **Alternativas descartadas**
  - *Importar OUTBOUND do Kommo no `n8n_chat_histories`*: cogitada na
    primeira hipótese (existe outro Salesbot externo). Descartada após
    confirmar que todas as notas têm sufixo `- EX-…` — são do próprio
    agente. Implementar isso seria duplicar o mecanismo de gravação.
  - *Forçar o LLM a sempre chamar a tool `enviar_form_sumar_inscricao`*:
    aumentaria a complexidade do prompt sem garantir 100% de obediência.
    O guard de saída já cobre a regressão "afirmou sem tool"; o auto-sync
    fecha o gap de "perguntou sem tool".
  - *Espelhar estado no card Kommo (`sum_Status_Inscricao`)*: já é feito
    em outros pontos, mas exige round-trip ao Kommo a cada turno; muito
    caro para ser a fonte primária.
  - *Gravar histórico ANTES do envio do WhatsApp*: introduziria histórico
    "fantasma" se o envio falhasse. Retry com backoff resolve o caso
    transitório sem esse risco.

- **Impacto**
  - **Resiliência:** o próximo turno do lead passa a ser processado
    corretamente mesmo se o histórico estiver vazio (race, falha de
    gravação, reset, TTL). O estado persistido no Supabase passa a ser a
    fonte primária de decisão; o histórico vira apoio.
  - **Telemetria:** logs `INSCRICAO_CTX` e `INSCRICAO_STATE_AUTO_SYNC`
    permitem diagnosticar regressões futuras em 1 grep no EasyPanel.
  - **Compatibilidade:** auto-sync é idempotente e não rebaixa estados
    avançados; fallback de notas só ativa quando mensagem "parece polo".
    Nenhum caminho existente foi alterado em seu comportamento default.
  - **Cobertura de testes:** seção 8 em `scripts/test-inscricao-flow.mjs`
    valida `detectStateFromReply` para reply canônico, com sufixo EX,
    neutro, vazio, e proteção de estados terminais.
