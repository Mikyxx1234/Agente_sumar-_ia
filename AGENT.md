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

### 2026-06-01 - Notas internas de auditoria não vazam como mensagem do candidato

- **Decisão**
  - Toda nota INTERNA de auditoria criada pelo agente (movimentação de
    funil, motivo de perda, comprovante recebido, reativação) passa a ser
    criada via novo helper `createLeadAuditNote` (`server/kommoClient.js`),
    que injeta o marcador estável `AGENT_AUDIT_NOTE_MARKER`
    (`· [registro interno IA]`).
  - O poll de inbound (`kommoInboundPoll`) descarta essas notas através de
    `isKommoSystemOrIntegrationNote`, que agora chama
    `isAgentInternalAuditNote` em duas camadas:
    - **Camada A (marcador):** qualquer nota com `[registro interno IA]`
      é auditoria — blindagem definitiva para notas futuras, independente
      do texto.
    - **Camada B (frases):** frases de auditoria já existentes no CRM
      ("Lead confirmou desistência", "Motivo da perda", "Comprovante de
      pagamento recebido", "movido para fila/pipeline", "após inatividade",
      "fila pós-matrícula") — defesa em profundidade para notas antigas
      sem o marcador.

- **Contexto**
  - O agente em produção lê mensagens via polling de notas do Kommo (não há
    webhook direto do WhatsApp para esses leads). O poll separa "fala do
    candidato" de "eco/sistema" por heurística de texto.
  - A nota de auditoria de desistência ("Lead confirmou desistência da
    inscrição via WhatsApp. Motivo da perda: Sem Interesse. Movido para
    fila 143…") não casava nenhum filtro e foi lida como **mensagem do
    candidato**, entrando no `n8n_chat_histories` como `user` (lead
    #23841399, id 54545). Isso corrompeu o contexto do LLM.
  - Havia 8 call sites de `createLeadNote`; vários gravavam notas internas
    com risco de vazar. O modelo era frágil: cada texto novo de nota
    interna podia vazar de novo.

- **Alternativas descartadas**
  - Só expandir o heurístico de texto (camada B isolada): "whack-a-mole" —
    cada nova frase de auditoria voltaria a vazar. Mantido apenas como
    defesa em profundidade.
  - Gravar auditoria com `note_type` distinto: Kommo trata `common` de
    forma especial e a integração WhatsApp também usa `common`; mudar o
    tipo arriscava quebrar a visualização no CRM e o que o poll já consome.

- **Impacto**
  - Notas de auditoria nunca mais entram no histórico do LLM como fala do
    candidato — atuais (camada B) e futuras (camada A).
  - Call sites roteados: `inscricaoDesistenciaFlow`, `inscricaoAceitePagamentoFlow`,
    `inactivityReengagement`, `matriculaCaptacaoPipeline`. `kommoSalesbot`
    e `whatsappSender`/`whatsappTemplateSender` mantêm `createLeadNote`
    (já filtrados por salesbot/sufixo EX-).
  - `createLeadAuditNote` é idempotente (não duplica o marcador).
  - Histórico corrompido do lead de teste #23841399 foi limpo (reset).
  - Testes seção 14 (14 asserts): texto exato da desistência, comprovante,
    inatividade, marcador arbitrário, e garantia de que fala real do
    candidato NÃO é classificada como auditoria. 139/139 passando.

- **Arquivos**
  - `libShared/inboundMessageSanitize.js`: `AGENT_AUDIT_NOTE_MARKER`,
    `isAgentInternalAuditNote`, plug em `isKommoSystemOrIntegrationNote`.
  - `server/kommoClient.js`: `createLeadAuditNote`.
  - `server/inscricaoDesistenciaFlow.js`, `server/inscricaoAceitePagamentoFlow.js`,
    `server/inactivityReengagement.js`, `server/matriculaCaptacaoPipeline.js`:
    roteados para o helper.
  - `scripts/test-inscricao-flow.mjs`: seção 14.

---

### 2026-05-28 - Pause gate com exceção para `desistencia_concluida` (early handler)

- **Decisão**
  - `flushSessionInner` (webhook Evolution) deixou de usar
    `isAtendimentoIaPaused` e passou a usar `shouldHoldOnIaPause`
    (`server/dadosClienteStore.js`). A decisão composta retorna
    `{ hold, paused, reason }`:
    - `atendimento_ia='pause'` + `inscricao_form_status='desistencia_concluida'`
      → `hold=false`, `reason='desistencia_concluida'` → drain prossegue.
    - Demais casos com `pause` → `hold=true` (bloqueia, igual antes).
  - `runAgent` ganhou um handler "early" `tryHandleDesistenciaJaRegistrada`
    rodando junto com `tryHandleCaptacaoInscricaoExistenteFlow` e
    `tryHandleMatriculaAceitePagamentoFlow`, ANTES do gate interno de
    pause. Esse handler só responde a mensagem canônica
    "Sua desistência já foi registrada…" quando o status do banco é
    `desistencia_concluida` — não depende de histórico.

- **Contexto**
  - Lead que confirmava desistência ficava com `atendimento_ia=pause`.
    Próxima mensagem (qualquer "boa tarde", "oi") era bloqueada por
    `flushSessionInner` e o lead nunca recebia resposta. O fallback
    "Sua desistência já foi registrada…" existia em
    `tryHandleInscricaoDesistenciaFlow` mas estava posicionado depois
    do gate de pause em `runAgent`, sendo inalcançável.
  - Bug reportado no lead #23841399 (William testest) — generalizado
    a qualquer lead que confirmasse desistência.

- **Alternativas descartadas**
  - Auto-reativar IA após pause: perigoso, pode roubar conversa de
    consultor humano em casos de `distribuir_humano`.
  - Remover `atendimento_ia=pause` do fluxo de desistência: quebraria
    a semântica de "encerrado" e poderia fazer o LLM oferecer
    reativação espontânea quando o lead só estava agradecendo.
  - Mover a checagem `isAtendimentoIaPaused` inteira para depois dos
    early handlers: cobriria o caso, mas perderia a otimização de
    `skipPauseCheck` no `runAgent` (round-trip extra a Supabase).

- **Impacto**
  - Lead que voltar a falar após desistência confirmada recebe
    sempre a mensagem canônica via early handler — sem precisar
    intervenção manual.
  - Demais casos de `atendimento_ia=pause` (matrícula em andamento,
    consultor humano) continuam bloqueando o drain, como antes.
  - Testes seção 13 cobrem `decideHoldOnIaPause` em 9 combinações
    (null row, paused null, pause genérico, pause + desistência,
    case-insensitive). 117/117 testes passando.
  - Função pura `decideHoldOnIaPause` torna o gate testável sem
    Supabase e abre espaço para outras exceções similares no futuro
    (cada uma com seu `reason` distinto).

- **Arquivos**
  - `server/dadosClienteStore.js`: `decideHoldOnIaPause` (pura) +
    `shouldHoldOnIaPause` (async).
  - `server/inscricaoDesistenciaFlow.js`: `tryHandleDesistenciaJaRegistrada`.
  - `server/ai/agentRunner.js`: plug do early handler antes do
    gate `isAtendimentoIaPaused`.
  - `server/evolution/webhookEvolution.js`: gate trocado para
    `shouldHoldOnIaPause` com log explícito quando há early handler.
  - `scripts/test-inscricao-flow.mjs`: seção 13 (11 asserts).

---

### 2026-05-28 - Separação TOTAL entre perfis (Atendimento com `mode: exclude`)

- **Decisão**
  - Estender `kommoScope` com campo `mode: 'include' | 'exclude'`
    (default `'include'`, preservando comportamento anterior).
  - **Agente Atendimento** passa a ter `kommoScope` ativo com
    `mode: 'exclude'` e `statusIds: [INSCRIÇÃO, AGUARDANDO_PAGAMENTO]`
    — Dashboard / Execuções / Feedback IA filtram **excluindo** leads
    que estão nessas duas colunas.
  - **Agente Inscrição** marcado explicitamente com `mode: 'include'`
    nos mesmos `statusIds`.
  - Helper compartilhado `leadMatchesScope(leadId, scopedState)` em
    `src/lib/funnelScope.js` centraliza a regra; cada componente apenas
    delega. Heurística para execuções sem `leadId` (playground, lookup
    falhou): `mode=include` descarta (não confirma pertencimento),
    `mode=exclude` mantém (não está nos status excluídos).
  - **Aba Matrículas removida do perfil Atendimento** (toda matrícula
    vem do agente de Inscrição; ficaria vazia após o filtro).
  - **Funil Kommo** recebe um escopo dedicado por perfil
    (`profile.kommoFunnelScope`), separado do `kommoScope` usado para
    filtragem client-side. Necessário porque o endpoint do Kommo só
    sabe filtrar por inclusão (sem operador "not in"):
    - Atendimento → `[ATENDIMENTO (106140284), AGUARDANDO_RESPOSTA (106377088)]`
    - Inscrição   → `[INSCRIÇÃO (106804680), AGUARDANDO_PAGAMENTO (106426128)]`
  - Constante `KOMMO_STATUS_AGUARDANDO_RESPOSTA = 106377088` levantada
    em 2026-05-28 via Network do Kommo (PATCH ao arrastar lead).

- **Contexto**
  - Após Fase 2, o perfil Atendimento ainda mostrava "tudo" em
    Dashboard/Execuções/Feedback IA, incluindo dados dos leads de
    INSCRIÇÃO/PAGAMENTO. Consultor pediu separação completa: Inscrição
    só os 2 status do agente de inscrição; Atendimento todo o resto.
  - Como o `status_id` de AGUARDANDO RESPOSTA ainda não foi
    levantado, a abordagem por **exclusão** (em vez de inclusão
    explícita dos status do Atendimento) evita o bloqueio: qualquer
    coluna nova no Kommo cai automaticamente em "Atendimento".

- **Alternativas descartadas**
  - *Listar explicitamente os `statusIds` do Atendimento*: precisaria
    do ID de AGUARDANDO RESPOSTA agora, e quebraria toda vez que uma
    coluna nova surgisse no funil.
  - *Filtrar `MatriculasViewer` com o mesmo `kommoScope`*: na prática
    daria lista vazia (matrícula → lead em INSCRIÇÃO/PAGAMENTO). Mais
    honesto remover a aba do perfil Atendimento.
  - *Estender o `Funil Kommo` do Atendimento por exclusão*: o endpoint
    do Kommo não tem operador "not in". Listar leads do pipeline
    inteiro e filtrar custaria muitos GETs extras — defere para quando
    tivermos o ID de AGUARDANDO RESPOSTA.

- **Impacto**
  - Atualizados: `src/lib/funnelScope.js`, `src/lib/agentProfiles.js`,
    `src/components/Dashboard.jsx`, `src/components/ExecutionViewer.jsx`,
    `src/components/FeedbackIA.jsx`, `src/App.jsx`.
  - Persistência: usuários que tinham `matriculas` como última página
    do perfil Atendimento caem automaticamente em `dashboard`
    (`loadPageForProfile` valida contra o `nav` atualizado).
  - Backend: zero mudança nesta entrega — usa o mesmo endpoint
    `/api/scheduler/funnel?statusIds=…` (chamado com os IDs do
    Inscrição em ambos os perfis; o que muda é a operação client-side).
  - Rollback: `git revert` da mudança restaura o comportamento parcial
    anterior (Atendimento sem filtro, Inscrição com filtro).

---

### 2026-05-28 - Perfis de agente no painel (Atendimento + Inscrição)

- **Decisão**
  - Painel React passa a ter **dois perfis de espaço de trabalho**, alternáveis
    via dropdown no topo da sidebar (padrão visual inspirado no troca-conta do
    Kommo):
    1. **Agente Atendimento** (perfil padrão) — mantém as 8 abas atuais:
       Dashboard, Funil Kommo, Prompts, Teste IA, Execuções, Feedback IA,
       Matrículas, Atualização IA.
    2. **Agente Inscrição** — 5 abas dedicadas: Dashboard, Execuções,
       Matrículas, Feedback IA, Funil Kommo (Inscrição).
  - Estado do perfil ativo persistido em `localStorage` (`agent_profile`).
  - **Página corrente é lembrada por perfil** (`agent_profile_page` é um
    objeto `{ atendimento: pageId, inscricao: pageId }`): trocar de perfil
    e voltar mantém a última aba aberta naquele perfil.
  - **Fase 1 (esta entrega)**: apenas a UI shell. As 4 abas do perfil
    Inscrição reusam os mesmos componentes do Atendimento, com um banner
    `InscricaoScopeBanner` no topo avisando que **o filtro por agente ainda
    não está aplicado** — exibem dados de todos os agentes até a Fase 2.
  - **Fase 2 (definição esclarecida em 2026-05-28)**: a separação é por
    **status (coluna) dentro do mesmo pipeline AGENTE-SUMARÉ** (`13756724`).
    Status IDs centralizados em `src/lib/agentProfiles.js`:
    - `KOMMO_STATUS_ATENDIMENTO = 106140284` (Agente Atendimento — já
      é o `KOMMO_AGENT_STATUS_ID` do `.env`)
    - `KOMMO_STATUS_INSCRICAO = 106804680` (Agente Inscrição)
    - `KOMMO_STATUS_AGUARDANDO_PAGAMENTO = 106426128` (Agente
      Inscrição — mesmo ID já em uso como `KOMMO_POS_MATRICULA_STATUS_ID`;
      lead vai pra cá após enviar comprovante)
  - Cada perfil tem `kommoScope: { pipelineId, statusIds }` na sua
    config. Componentes que precisam filtrar dados por agente recebem
    esse `kommoScope` via prop e filtram client-side (ou via query
    param quando o endpoint suporta).
  - **Implementação por aba** está sendo feita progressivamente após
    a definição dos IDs (ver entrada subsequente).

- **Contexto**
  - Negócio terá dois agentes operando em paralelo: um faz atendimento
    comercial (já existente), outro automatiza inscrições/matrículas.
  - Consultor pediu separação visual pra "não ficar tudo junto e confuso"
    — métricas, feedback e funil de cada agente isolados.
  - Espelha o padrão do Kommo onde cada conta tem perfis (CRUZEIRO,
    ANHANGUERA, UEaD, etc.) trocáveis pelo header do app.

- **Alternativas descartadas**
  - *Rotas distintas (`/atendimento/*` vs `/inscricao/*`)*: o app não usa
    react-router, adicionaria dependência só pra isso.
  - *Tabs/segmented control no header de cada tela*: ocuparia espaço útil
    da página e não dá a sensação de "espaço de trabalho separado" que o
    usuário pediu.
  - *Implementar tudo em uma fase (UI + filtros de dados)*: como o
    critério de separação dos dados ainda não está definido pelo
    negócio, isso travava o trabalho. Separar em fases libera a UI já
    e deixa o filtro pra quando a regra estiver clara.

- **Impacto**
  - Novos arquivos: `src/lib/agentProfiles.js` (definição central dos
    perfis + helpers de persistência), `src/components/AgentProfileSwitcher.jsx`
    (botão + dropdown), `src/components/InscricaoScopeBanner.jsx` (banner
    da Fase 1).
  - `src/components/Sidebar.jsx`: deixa de ter `NAV_ITEMS` fixa, recebe
    `activeProfile` e `onProfileChange` por props.
  - `src/App.jsx`: roteamento passa a depender do par `(profileId, pageId)`;
    as 4 abas do perfil Inscrição (`inscricao-matriculas`,
    `inscricao-dashboard`, `inscricao-feedback`, `inscricao-funil`)
    renderizam wrappers com banner + componente existente.
  - CSS em `src/App.css`: novas classes `.profile-switcher`,
    `.profile-switcher-trigger`, `.profile-switcher-dropdown`,
    `.profile-switcher-item`, `.inscricao-scope-banner`.
  - Para adicionar um terceiro perfil no futuro: basta acrescentar
    entrada em `PROFILES` no `agentProfiles.js` (sem mexer em Sidebar
    ou App.jsx).

---

### 2026-05-28 - Fase 2 perfis: filtro client-side por escopo Kommo

- **Decisão**
  - Cada componente que precisa filtrar por agente recebe a prop
    `kommoScope = { pipelineId, statusIds }` quando renderizado dentro
    do perfil Agente Inscrição. Quando a prop é null (perfil Atendimento
    ou contexto sem perfil), comportamento é IDÊNTICO ao anterior — sem
    filtro algum.
  - Helper compartilhado em `src/lib/funnelScope.js`:
    - `buildFunnelUrl(scope)` — monta `/api/scheduler/funnel?pipelineId=X&statusIds=Y,Z`
    - `fetchScopedFunnel(scope)` — chama o endpoint e devolve `Set<leadIds>`
    - `useScopedLeadIds(scope)` — hook React que recarrega quando o scope muda
  - Aplicação por tela do perfil Agente Inscrição:
    - **Funil Kommo (Inscrição)**: passa o scope no fetch — backend
      devolve leads dos 2 status (`106804680` + `106426128`)
    - **Feedback IA**: filtra avaliações cujo `lead_id` está no
      `Set<leadIds>` retornado pelo funil do scope
    - **Dashboard**: filtra execuções com `getExecutionLeadId(exec)`
      (extrai leadId dos `steps` que fazem lookup Kommo) e mantém só
      as que estão no `Set<leadIds>`
    - **Execuções**: mesmo `ExecutionViewer.jsx` do perfil Atendimento,
      mas recebendo `kommoScope` → aplica o mesmo filtro que o
      Dashboard antes dos demais filtros (status/feedback/tools/etc.)
    - **Matrículas**: sem filtro adicional — toda matrícula registrada
      já é resultado do agente de inscrição por natureza
  - Banner `InscricaoScopeBanner` removido das 4 abas (componente foi
    mantido no repo caso seja útil em outras situações futuras).

- **Backend (única mudança aditiva)**
  - `server.js` → `/api/scheduler/funnel` agora aceita query params
    OPCIONAIS `?pipelineId=X&statusIds=Y,Z`. Quando ausentes, usa
    `KOMMO_AGENT_PIPELINE_ID`/`KOMMO_AGENT_STATUS_ID` do `.env`
    (comportamento original). Quando presentes, busca leads de cada
    status via `listLeadsByStatus` (1 GET por status) e concatena.
  - Endpoint continua **read-only** no Kommo — sem PATCH, sem mover
    lead, sem mensagem. Sem efeitos colaterais em schedulers, Redis,
    Supabase ou WhatsApp.
  - Resposta inclui campos novos no `config`: `effectivePipelineId`,
    `effectiveStatusIds`, `scoped` (boolean).

- **Contexto**
  - Pipeline AGENTE-SUMARÉ é único; agentes diferentes operam em
    colunas (status) diferentes. Para separar visualmente os dados
    no painel, basta filtrar pelos status_ids correspondentes a cada
    agente.
  - Status IDs foram descobertos manualmente pelo consultor via
    DevTools do Kommo (resposta `/api/v4/leads/pipelines/13756724`).

- **Alternativas descartadas**
  - *Coluna nova na tabela `ai_rule_evaluations` armazenando
    `status_id_at_eval`*: mudança de schema, requer migration,
    afeta backfill. Filtragem client-side é mais simples e suficiente.
  - *Endpoint novo `/api/scheduler/funnel/inscricao`*: duplicaria
    código sem ganho — o original já recebe os dois IDs como
    parâmetros, mais limpo.

- **Impacto**
  - Mudança no backend é **aditiva e retroativa-compatível**: 100%
    do tráfego atual (sem query params) continua idêntico.
  - Aumento marginal de uso da API Kommo: ao abrir "Funil Kommo
    (Inscrição)", o painel faz 2 GETs em vez de 1 a cada 10s. Ainda
    bem dentro do rate limit (7 req/s do Kommo).
  - Nenhum env novo necessário; status IDs ficam em
    `src/lib/agentProfiles.js` (constantes exportadas).
  - Rollback trivial: `git revert` do único commit afeta apenas a
    feature nova; o resto continua funcionando.

---

### 2026-05-28 - Redesign da tela "Execuções" (filtros + reorganização visual)

- **Decisão**
  - Reorganizar `src/components/ExecutionViewer.jsx` mantendo a estrutura de
    painel duplo (lista à esquerda, detalhe à direita) e adicionar:
    1. Barra de filtros com `status` (todos/sucesso/erro), `feedback`
       (todos/👍/👎/sem), `tools` (todos/com/sem), `período`
       (todos/hoje/7d/30d) e `ordenação` (mais recente/antigo/demorado).
    2. Stat-cards no topo: total, erros, tempo médio, tokens totais.
    3. Cards da lista com hierarquia visual revisada (status + tempo
       relativo no topo, mensagem em destaque, ID + duração + tools no
       footer).
    4. Agrupamento da lista por data (Hoje / Ontem / Esta semana /
       Este mês / Mais antigos) com headers sticky.
    5. Toolbar do header: ações destrutivas (Limpar) separadas
       visualmente das demais; botões de Reindexar FAQ ficam em
       grupo secundário (visual mais discreto).

- **Contexto**
  - Tela tinha apenas busca textual por ID/mensagem, sem filtros por
    status, feedback, presença de tools ou período. Consultor relatou
    "conversas sem filtro e bem desorganizado".
  - Header misturava ações de Reindexar FAQ com Atualizar/Limpar no
    mesmo nível visual, dificultando localizar a ação desejada.

- **Alternativas descartadas**
  - *Apenas adicionar filtros sem mexer no layout*: resolveria 1/2 do
    problema relatado; ficaria visualmente igual.
  - *Refactor maior (tabela, drawer modal para detalhe, export CSV,
    bulk delete)*: sairia do padrão das outras telas
    (Conversas, FeedbackIA), mais risco de regressão.

- **Impacto**
  - Sem alterações em backend, contrato de `executionStore` ou
    `executionFeedbackStore`. Filtragem/ordenação 100% client-side
    sobre o array já carregado.
  - CSS novo em `src/App.css`: `.exec-stats`, `.exec-stat-card`,
    `.exec-filters`, `.exec-filter-group`, `.exec-segmented`,
    `.exec-group-header`. Reaproveita variáveis e tokens existentes.
  - Padrão de filtros (segmented control) fica como referência para
    aplicar nas demais telas que listam dados (FeedbackIA, Conversas,
    Matrículas) se necessário no futuro.

---

### 2026-05-28 - Desistência de inscrição (sem interesse) → fila 143

- **Decisão**
  - Quando o agente já apresentou o curso, tirou dúvidas e o lead declara
    que **não quer seguir com a inscrição**, o fluxo servidor
    (`tryHandleInscricaoDesistenciaFlow`) intercepta antes do LLM:
    1. Pergunta canônica de confirmação (outros cursos, consultor, ou
       confirmar desistência).
    2. Se o lead confirma → agradece, pausa IA, grava
       `sum_Motivo da perda = "Sem Interesse"` e move para
       `pipeline=13756724 / status=143`.
  - Se o lead volta atrás ("quero me inscrever", "mudei de ideia") → limpa
    status e deixa o fluxo normal continuar.
  - Não roda durante matrícula ativa (form, polo, aceite contrato, etc.).

- **Contexto**
  - Leads que desistem após tirar dúvidas ficavam no funil de atendimento IA
    sem registro formal de perda no Kommo.

- **Alternativas descartadas**
  - *Deixar só o LLM decidir*: inconsistente; sem PATCH no campo enum nem
    movimentação garantida.

- **Impacto**
  - Env: `INSCRICAO_DESISTENCIA_ENABLED`, `KOMMO_DESISTENCIA_STATUS_ID=143`,
    `KOMMO_DESISTENCIA_PIPELINE_ID=13756724`.
  - Estados: `aguardando_confirm_desistencia`, `desistencia_concluida`.

---

### 2026-05-28 - Pós-matrícula: agradecimento + mover lead para fila de instruções

- **Decisão**
  - Quando o lead envia o comprovante de pagamento (imagem ou texto
    canônico) APÓS o link de contrato, o agente:
    1. Agradece a matrícula e informa que as instruções para iniciar o
       curso serão encaminhadas em breve (texto canônico atualizado em
       `buildComprovantePagamentoRecebidoReply`).
    2. Cria nota Kommo com o comprovante e o destino.
    3. **Move o lead** via `updateLeadPipelineStatus` para a fila
       pós-matrícula `pipeline=13756724 / status=106426128`
       (envs `KOMMO_POS_MATRICULA_PIPELINE_ID` /
       `KOMMO_POS_MATRICULA_STATUS_ID`).
  - **Substitui** a chamada anterior de `runDistribuirHumano` (que
    distribuía para consultor de vendas) — lead matriculado não precisa
    mais de consultor de vendas, só de quem distribui instruções de
    início de curso.

- **Contexto**
  - Antes, o lead matriculado caía na rotina de distribuição comercial
    (resumo IA + escolha de consultor de vendas + tabela
    `distribuicao_por_consultor`), o que era desperdício: ele já tinha
    fechado matrícula, não precisava mais ser tratado como prospect.
  - Negócio quer uma fila dedicada para "alunos matriculados aguardando
    instruções para iniciar o curso", visível no CRM.

- **Alternativas descartadas**
  - *Manter `runDistribuirHumano` e adicionar a movimentação*:
    duplicava trabalho e o lead acabaria com dois donos (consultor
    comercial + fila pós-matrícula).
  - *Mover sem nota Kommo*: perderia rastreabilidade (auditoria do
    comprovante recebido + razão da movimentação).

- **Impacto**
  - Reply mais coerente com o estado real do lead.
  - Fila pós-matrícula passa a receber 100% dos leads que mandam
    comprovante via WhatsApp.
  - Se o `id_lead` não estiver disponível em `dados_cliente_sum`, o
    código loga warning e **não move** (degrada graceful, não quebra a
    resposta ao lead).
  - Configurável por env para mover destino sem redeploy.

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
    `polo_inscricao_escolhido`, `captacao_unidade`, `id_lead`, `teste_ab`
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

### 2026-06-01 - Cap de idade em findLastFormularioSumSentMs (loop pós-formulário)

- **Decisão**
  `findLastFormularioSumSentMs` passou a aceitar `{ maxAgeMs, nowMs }`
  opcionais. Em `detectFormSumarRecebidoNoKommo`
  (`server/inscricaoPostFormPipeline.js`) a referência do "formulário
  enviado" é capada por `INSCRICAO_FORM_KOMMO_NOTE_MAX_AGE_H` (default 48h):
  nota de formulário fora da janela NÃO ancora mais a detecção por eventos
  de campo nem por snapshot.

- **Contexto**
  Lead #23841399 ficava mudo após cada reset. Diagnóstico (via API Evolution
  + memória Supabase): o Evolution recebia as mensagens normalmente na
  instância ativa `SUMARE_IA` (webhook ON, `MESSAGES_UPSERT`), mas o agente
  estava pausado (`atendimento_ia='pause'`, `inscricao_form_status=
  'distribuir_consultor'`). Causa: uma nota antiga `Salesbot Formulario_Sum
  ativado` (29/mai, ~69h) continuava servindo de âncora; como `formSentMs`
  era calculado sem limite de idade, o ramo de `custom_field_*_value_changed`
  recontava mudanças de campo do card (inclusive pós-reset) e re-detectava
  "formulário recebido" → tentativa de matrícula falha (dado de teste) →
  pausa da IA. Loop a cada reset.

- **Alternativas descartadas**
  - *Apagar a nota antiga no Kommo a cada reset*: frágil (depende de permissão
    e de varrer notas), não resolve o caso real de produção com notas legadas.
  - *Reduzir o cap global de `maxAgeMs` da detecção*: afetaria a janela do
    loop de notas legítimo (resposta de flow que chega horas depois).
  - *Capar dentro de `findLastFormularioSumSentMs` por padrão*: mudaria o
    comportamento de `postFormSendGuard.js`, que quer a última referência
    independente da idade. Por isso o cap é opt-in via parâmetro.

- **Impacto**
  - Pós-formulário não re-dispara sobre formulário fora da janela; fim do
    loop de pausa após reset. Caminho legítimo (form enviado e respondido
    dentro de 48h) intacto — o loop de notas recentes continua detectando.
  - `postFormSendGuard.js` inalterado (cap opt-in).
  - **Testes:** `scripts/test-form-notes-age-cap.mjs`
    (`npm run test:form-notes-age-cap`, 6/6) cobre sem cap, nota velha
    ignorada, nota recente mantida, mistura, sem nota e cap desativado.
    Suíte `test:inscricao-flow` segue 139/139.
