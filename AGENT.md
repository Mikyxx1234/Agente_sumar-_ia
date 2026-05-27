# AGENT — Decisões arquiteturais

Registro cronológico de decisões que afetam padrão, dependências ou
estrutura do projeto. Conforme `Governança de Tarefas`, tarefas
complexas devem ser registradas aqui após aprovação do usuário.

---

### 2026-05-27 — Pós-link contrato: IA pausa e status API valida reenvio

**Decisão.** Depois que `runMatriculaCaptacaoAfterForm` registra o candidato
na API Sumaré e envia o link `SUMARE_CONTRATO_PORTAL_URL?id={candidato}`,
a IA generativa **entra em pausa** (`atendimento_ia=pause`). O candidato lê
o contrato, aceita e paga no portal. Só fluxos canônicos respondem após o
link: reenvio do link (se pedido) e recebimento de comprovante de pagamento
— `tryHandleMatriculaAceitePagamentoFlow` roda ANTES do gate `ia_paused` no
`agentRunner`, então segue ativo.

**Contexto.** Bug duplo:
1. Em `executeCaptacaoAfterFormResolved`, `contratoWhatsappSent` era
   declarado `false` e nunca atualizado — o `agentScheduler` lia o flag,
   detectava reply com `sumare.edu.br` + `contrato`, e reenviava o link
   pelo WhatsApp (duplicação garantida).
2. A IA seguia ativa em `aguardando_aceite_contrato`, podendo gerar
   respostas variadas sobre o contrato em vez de aguardar leitura/aceite
   do candidato.

**Implementação.**
- `inscricaoPostFormPipeline.js`: `contratoWhatsappSent = true` quando o
  link foi enviado com sucesso (ou pulado por dedupe). `pauseAtendimentoIa`
  agora cobre também o estado `aguardando_aceite_contrato`.
- `matriculaCaptacaoPipeline.js`: nova função `fetchCandidatoStatus` usa
  `GET /api-status-candidato/candidato/status?candidato={id}` — segunda
  barreira anti-duplicação. Se status é `matriculado` / `aceite` /
  `contrato` / `pagamento`, dedupe entra mesmo sem janela de 6h.
- `inscricaoAceitePagamentoFlow.js`: pedido de reenvio do link consulta a
  API antes; já matriculado → resposta canônica "consultor entrará em
  contato", sem reenviar link.

**Impacto.** O agente faz exatamente um envio do link e silencia até o
candidato mandar comprovante de pagamento. Falha de rede na API de status
é silenciosa (não bloqueia reenvio).

---

### 2026-05-27 — Trinco fixo do funil Kommo (só pipeline 13756724 + status 106140284)

**Decisão.** O atendimento automático via WhatsApp/scheduler só roda se o lead
estiver em **pipeline_id 13756724** (Agente-Sumaré) e **status_id 106140284**
(Atendimento). IDs fixos em `server/kommoAgentFunnelGate.js`; variáveis
`KOMMO_AGENT_*` no `.env` que divergirem são ignoradas (warn no boot).

**Contexto.** Lead `#23842805` no funil SUMARÉ-COMERCIAL / em atendimento
recebeu resposta da IA (`EX-260526-1416-239-6d15`) após SalesBot mover a
etapa — fora da fila Agente-Sumaré. Causas: env de produção possivelmente
apontando para outro funil e/ou `WEBHOOK_ORPHAN_FLUSH` processando buffer
sem checar etapa.

**Implementação.**
- `assertLeadInAgentFunnel` antes de `drainMessages` em `flushSessionInner`.
- Scheduler: mesma checagem no flush normal e no flush órfão (por telefone).
- `listLeadsInAgentQueue` lista só o par fixo de IDs.
- Teste: `npm run test:funnel-gate`.

**Impacto.** Leads em outros funis (ex.: SUMARÉ-COMERCIAL, tag Fora_Horário)
podem ter mensagens no buffer, mas a IA **não responde** até estarem em
13756724 / 106140284. Playground (`/api/playground/flush`, `/api/agent/run`)
não passa pelo gate (teste manual).

---

### 2026-05-27 — Gate outbound: separar race condition de dedupe legítimo

**Decisão.** O retorno de `shouldSkipDuplicateOutbound` (`server/outboundDedupe.js`)
passa a distinguir dois cenários que antes eram colapsados em
`{ skip: true, deduped: true, sent: 0 }`:

1. **Race condition** (`outbound_inflight_sync`): outro envio para o mesmo
   telefone está em curso no mesmo processo. Sinalizado com
   `{ skip: true, race: true, reason: 'outbound_inflight_sync' }` e
   propagado por `sendMessageWithNote` como
   `{ ok: false, race: true, sent: 0, code: 'OUTBOUND_INFLIGHT_RACE' }`.
2. **Dedupe legítimo** (identical/prefix/similar match em
   `chat_messages`): mensagem idêntica já foi enviada recentemente.
   Mantém `{ ok: true, deduped: true, sent: 0 }`.

Em `webhookEvolution.js` o cálculo de `sentOk` passa a excluir o race
(`sendResult.race === true` nunca conta como envio bem-sucedido) e o
`recordBufferFlushHash` só grava o hash quando **`sent > 0`** — nunca
mais quando o envio foi pulado.

**Contexto.** Lead `#23841399` em 26/05 às 17:23 BRT:
- Execução `EX-260526-2023-190-4e43` salvou `response` correto e `error: null`,
  mas o step `whatsapp.sendMessageWithNote` registrou `{ ok: true, sent: 0,
  total: 1 }` — envio nunca chegou ao cliente.
- A causa foi `tryReserveOutboundSync` retornando `false` (lock in-memory
  de 120s ocupado por outra chamada concorrente — provável race entre
  webhook Evolution e `KOMMO_INBOUND_POLL_ENABLED=true`).
- Como `sendResult.deduped === true`, o código tratava `sentOk = true`,
  marcava `replyCooldown` e gravava `recordBufferFlushHash` (TTL 1h).
- Quando o cliente repetiu "boa tarde" às 17:25, `shouldSkipStaleBufferFlush`
  casou o hash e `clearBufferIfStaleRepush` esvaziou o buffer sem chamar a IA.
- Resultado: 2 "boa tarde" engolidos, nenhum sinal de erro no painel.

**Alternativas descartadas.**
- *Re-empurrar mensagens no buffer em race.* Race é rara (<120s); confiar
  no próximo tick do scheduler é mais simples. O cliente ou o
  `KOMMO_INBOUND_POLL` repropagam a mensagem; o que importa é não gravar
  o hash que bloqueia a próxima tentativa.
- *Aumentar TTL do `inflightOutbound` ou usar Redis distribuído.* Não
  resolve: o problema não é o lock acertar, é a falha do lock ser
  silenciada como dedupe.
- *Remover o lock in-memory.* Aumenta risco de envio duplicado real.

**Impacto.**
- `server/outboundDedupe.js`: `shouldSkipDuplicateOutbound` retorna
  `race: true` quando `tryReserveOutboundSync` falha.
- `server/whatsappSender.js`: `sendMessageWithNote` propaga
  `{ ok: false, race: true, code: 'OUTBOUND_INFLIGHT_RACE' }` em vez
  de mascarar como dedupe; dedupe legítimo segue retornando `ok: true`.
- `server/evolution/webhookEvolution.js`: `sentOk` ignora `race`; só
  grava `recordBufferFlushHash` quando `sent > 0`; race gera
  `executionError` legível no painel (`WhatsApp race: ... — mensagem
  permanecerá no buffer para o próximo tick`).
- Cobertura: `scripts/test-outbound-dedupe-race.mjs` (npm
  `test:outbound-dedupe-race`) valida os 3 branches (race, dedupe
  legítimo, sucesso).

---

### 2026-05-26 — Ações de inscrição só via tool, nunca por texto

**Decisão.** Toda ação de inscrição (envio do formulário Form Sumar,
registro de polo, confirmação de recebimento do formulário e disparo da
API Captação Sumaré) **só pode acontecer por chamada explícita de tool**
pelo LLM. O servidor responde com **texto canônico** (`replyOverride`),
descartando qualquer `msg.content` do LLM nesse turno. Um `replyGuard`
roda em todos os turnos: bloqueia respostas que afirmam essas ações sem
a tool correspondente e substitui pelo texto seguro do estado atual.

**Contexto.** Regressões `EX-1654`, `EX-1657`, `EX-1659`, `EX-1737`,
`EX-1739`, `EX-1813` compartilhavam o mesmo padrão: o LLM "narrava" uma
ação (ex.: "acabei de enviar o formulário"), mas o servidor não havia
disparado o salesbot Kommo nem gravado o estado em Supabase. Heurísticas
de texto (`messageConfirmsProceedToInscricaoForm`,
`assistantInEnrollmentStep`, `assistantAskedPoloPreFormChoice` etc.)
tentavam adivinhar a intenção e quebravam a cada fraseado novo. A
correção definitiva é desacoplar narração de execução: o LLM **pede**
via tool, o servidor **executa e responde**.

**Alternativas descartadas.**
- *Mais heurísticas de texto.* Caminho que originou as 6 regressões;
  cada novo fraseado do LLM ou do lead exige outro detector.
- *Apenas guard de saída.* Bloquearia narrativas erradas mas não
  enviaria o formulário — lead receberia mensagem fria do servidor sem
  ação real.
- *Tool única `inscricao(...)` agregada.* Esconde o estado e gera
  ambiguidade sobre quando chamar — preferimos 3 tools com nome
  imperativo e propósito único.

**Impacto.**
- Novas tools no LLM: `enviar_form_sumar_inscricao`,
  `registrar_polo_inscricao`, `confirmar_recebimento_formulario`
  (`server/ai/toolDefinitions.js` + `server/inscricaoActionTools.js`).
- `server/ai/agentRunner.js`:
  - encerra o loop de rounds quando uma tool de ação retorna
    `{ ok, replyOverride }` e usa esse texto como reply final;
  - injeta o estado de inscrição (`inscricao_form_status`) no
    `contextPreamble` para o LLM saber qual tool chamar;
  - injeta o hint `TOOLS DE INSCRIÇÃO` em todos os turnos;
  - aplica `validateReplyAgainstActions` (`server/replyGuard.js`) antes
    do return final.
- Telemetria em `mensagens_ia.steps`: `tool_action_reply_override`,
  `reply_guard` (com `code`/`stage_before`), e em `ctxSnapshot`:
  `acao_inscricao_tomada`, `stage_before`, `stage_after`,
  `guard_violation`, `replySource`.
- Fixtures E2E: `scripts/test-inscricao-flow.mjs` (npm
  `test:inscricao-flow`) com 6 cenários canônicos. Pre-deploy em
  `scripts/easypanel-deploy-agente-sumare.ps1` aborta o deploy se o
  teste falhar.
- Heurísticas legadas (`tryEnsureInscricaoFormSent`,
  `llmReplyImpliesPendingFormSend`, `messageConfirmsProceedToInscricaoForm`,
  `assistantAskedPoloPreFormChoice`, `messageLooksLikeFormSumarResponse`)
  permanecem como **fallback** em caso de regressão; não disparam mais
  ações isoladamente — a defesa primária é o trio (tool → reply
  override → guard).

**Padrão para tarefas futuras.** Qualquer nova ação que altere estado
externo (Kommo, Sumaré, Supabase) deve seguir esta arquitetura:
1. Definir uma tool com nome imperativo em `server/ai/toolDefinitions.js`.
2. Implementar executor que retorna `{ ok, code, text, replyOverride, ctxSnapshot, steps }`.
3. Gravar o novo estado em Supabase **antes** do disparo externo (transição atômica).
4. Adicionar regex/regra no `replyGuard.js` se o LLM puder "narrar"
   essa ação sem chamá-la.
5. Cobertura E2E em `scripts/test-inscricao-flow.mjs` (ou script irmão).
6. Documentar a decisão neste arquivo.

---

### 2026-05-22 — Polo EAD pós Form Sumar antes da API Captação

**Decisão.** Após detectar o Form Sumar preenchido, o agente pergunta em
qual dos 5 polos EAD o candidato deseja estudar (com endereço), salvo se
`polo_inscricao` ou código `unidade` já constarem no card Kommo (prioridade
Kommo). Após confirmação do polo, dispara `runCaptacaoContratoWorkflow`
(gerar → status → aceite → link contrato no WhatsApp).

**Contexto.** Requisito do usuário: dados do Kommo primeiro; escolha de polo
obrigatória antes da inscrição no sistema Sumaré; polos fixos SP (São Miguel,
Barra Funda, Tatuapé, Santana, Pinheiros).

**Alternativas descartadas.**
- *Captação imediata após form (sem polo).* Não atende regra de negócio.
- *Polo só via LLM/tool.* Resposta estruturada (1–5 ou nome) é mais confiável
  e barata que classificação livre.

**Impacto.**
- `libShared/sumarePoloCatalog.js` — catálogo, match, mensagens WhatsApp.
- `libShared/inscricaoFormHeuristics.js` — status `aguardando_escolha_polo`.
- `server/inscricaoPostFormPipeline.js` — pergunta polo; `executeCaptacaoAfterFormResolved`.
- `server/inscricaoPoloFlow.js` — `tryHandlePoloEscolhaFlow` no `agentRunner`.
- `SUMARE_CAPTACAO_POLO_UNIDADE_MAP` em `.env.example` — códigos `ED_SP_P1`…`P5`
  são **placeholders** até validação com a Sumaré.

---

### 2026-05-20 — Aba "Feedback IA" com avaliador automático contra Regras 1-22

**Decisão.** Adicionar nova aba `feedback-ia` no painel para avaliar
automaticamente, conversa por conversa, se a IA seguiu as regras do
override (`server/ai/promptsLoader.js`, regras 1–22). Avaliação dispara
quando um lead **sai do funil** monitorado pelo `agentScheduler`.
Modelo: `gpt-5` (em avaliação e em sugestão de patch). Persistência em
nova tabela Supabase `ai_rule_evaluations`. Fase 1 só avalia e sugere —
**não aplica patch automaticamente** no prompt.

**Contexto.**
- O lead conversa com a IA enquanto está no `KOMMO_AGENT_PIPELINE_ID +
  KOMMO_AGENT_STATUS_ID`. Quando muda de status (operação humana, fim
  de funil, descarte, matrícula), o lead "sai". Esse é o momento
  natural para auditar todos os turnos da conversa de uma só vez.
- Já existe `mensagens_ia` no Supabase com cada turno (`user_message`,
  `response`, `tool_calls`, `steps`, `usage`). É a fonte da avaliação.
- Já existe `agent_training_feedback` (positivo/negativo humano) e o
  `feedbackJob` cron (avalia **consultor humano** — fonte
  `mensagens_atendimento_comercial`). Nenhum dos dois cobre auditoria
  da própria IA contra regras.
- Regras 1-22 estão hardcoded no template literal `override` em
  `promptsLoader.js`. Patch automático sobre substring é frágil; por
  isso Fase 2 (extração para tabela `agent_rules`) fica para depois.

**Alternativas descartadas.**
- *Reuso do `feedbackJob`.* Mistura responsabilidades — ele já é cron
  pago de avaliação do consultor humano. Adicionar regras da IA no
  mesmo runner aumenta acoplamento e custo do cron.
- *Avaliação por turno isolado.* Perde continuidade — Regra 5 (memória),
  17 (resposta curta), 7 (matrícula multi-turno) só fazem sentido vendo
  a conversa inteira.
- *Patch automático sem aprovação humana.* Inaceitável: regras estão
  no prompt de produção; risco de regredir comportamento em escala.
  Patch sempre passa por aprovação manual (Fase 2).
- *`gpt-4.1` como avaliador.* Usuário pediu "o melhor mesmo que mais
  caro". `gpt-5` tem follow-instructions superior em prompt com 22
  regras numeradas.

**Impacto.**
- Novos arquivos:
  - `scripts/sql/ai_rule_evaluations.sql` — tabela com `lead_id`,
    `verdict`, `score`, `per_rule jsonb`, `suggestion_*`, `status`.
  - `server/feedbackIA/ruleEvaluator.js` — orquestra chamada OpenAI.
  - `server/feedbackIA/evaluationStore.js` — persistência Supabase.
  - `server/feedbackIA/funnelExitWatcher.js` — diff de quem estava no
    funil entre ticks → enfileira avaliação.
  - `src/components/FeedbackIA.jsx` — UI alinhada ao mockup.
  - `src/lib/feedbackIAStore.js` — cliente fetch.
- Alterações:
  - `server.js` — endpoints `POST /api/feedback-ia/evaluate`,
    `GET /api/feedback-ia/evaluations`, `GET /api/feedback-ia/stats`.
  - `server/agentScheduler.js` — chama `funnelExitWatcher` ao final do
    tick.
  - `server/ai/modelRegistry.js` — papéis `rules_eval` (default
    `gpt-5`) e `rules_patch` (default `gpt-5`).
  - `src/lib/openaiPricing.js` — tarifas `gpt-5` / `gpt-5-mini`.
  - `src/components/Sidebar.jsx` + `src/App.jsx` — entrada do menu
    entre Execuções e Matrículas.
  - `.env.example` — `OPENAI_MODEL_RULES_EVAL`,
    `OPENAI_MODEL_RULES_PATCH`, `FEEDBACK_IA_ENABLED`.
- Custo estimado: conversa de 5–10 turnos no `gpt-5` ≈ US$ 0,02–0,05.
  100 leads/dia ≈ US$ 60–150/mês. `FEEDBACK_IA_ENABLED=false` desliga
  tudo.
- Fase 2 (extrair regras para `agent_rules` versionado + aplicação
  manual de patch) só após Fase 1 validada em produção.

---

### 2026-05-20 — Feedback IA · Fase 2: regras versionadas em DB + patch aprovado

**Decisão.** Extrair as 22 regras hardcoded em `promptsLoader.js` para
duas tabelas Supabase (`agent_rules` + `agent_rule_versions`).
`getAgentRulesText` continua **síncrono** e fica com cache em memória
de 60s. Em caso de falha do Supabase (timeout, tabela ausente, REST
caiu), **fallback automático para o texto hardcoded**: o agente nunca
fica sem prompt. Patch sugerido pelo avaliador vira diff aprovável na
aba "Otimizar Prompt" (chama `gpt-5` papel `rules_patch` para
consolidar evidências de várias avaliações). Após aprovação humana,
nova versão é gravada e o cache invalidado — o próximo turno do agente
já usa o texto novo.

**Contexto.**
- Fase 1 já registra violações por regra em `ai_rule_evaluations.per_rule`.
- O hardcoded em `promptsLoader.js` é fonte única de verdade hoje;
  alterá-lo exige deploy. Patch versionado em DB permite ajustar
  comportamento sem novo build, com auditoria completa de quem mudou
  o quê e quando.

**Alternativas descartadas.**
- *Arquivo JSON no repo + commit por patch.* Exige deploy a cada
  ajuste e perde o ciclo "avaliação → sugestão → aprovação → ativação"
  num mesmo painel.
- *Tornar `getAgentRulesText` async.* Forçaria refactor do
  `agentRunner` (cadeia síncrona). Não vale a pena: cache em memória
  de 60s resolve sem mudar interface.
- *Substituir hardcoded sem fallback.* Inaceitável — se o Supabase
  cai, agente fica sem prompt. Fallback hardcoded é o salva-vidas.
- *Patch aplicado direto pelo avaliador, sem aprovação.* Já descartado
  na Fase 1 e mantido aqui — sempre passa por humano.

**Impacto.**
- Novos arquivos:
  - `scripts/sql/agent_rules.sql` — `agent_rules` (1 row por regra) +
    `agent_rule_versions` (histórico). PKs e checks.
  - `server/feedbackIA/rulesStore.js` — CRUD via Supabase REST.
  - `server/feedbackIA/rulesSeed.js` — parser do texto hardcoded
    (regex em multilinha) + seed idempotente.
  - `server/feedbackIA/patchGenerator.js` — agrega evidências de
    `ai_rule_evaluations.per_rule` por `rule_id` e chama `gpt-5`
    (papel `rules_patch`) com JSON Schema para sugerir nova redação.
- Alterações:
  - `server/ai/promptsLoader.js` — cache module-level
    `_rulesCache: { ts, list }`; `getAgentRulesText` síncrono prefere
    cache se válido, senão hardcoded; refresh em background ao boot e
    quando endpoint de apply invalida o cache.
  - `server.js` — endpoints `GET /api/feedback-ia/rules`,
    `GET /api/feedback-ia/rules/:id/violations`,
    `POST /api/feedback-ia/rules/:id/generate-patch`,
    `POST /api/feedback-ia/rules/:id/apply`,
    `POST /api/feedback-ia/rules/:id/rollback`. Seed roda no boot.
  - `src/components/FeedbackIA.jsx` — aba "Otimizar Prompt" sai do
    placeholder, mostra regras com violações + botões Gerar/Aprovar/
    Rollback + diff side-by-side simples.
  - `src/lib/feedbackIAStore.js` — wrappers fetch dos endpoints novos.
- Custo: chamada de patch ≈ US$ 0,03–0,08 cada (gpt-5 com contexto
  longo). É ação manual; não roda em loop.

**Salvaguardas.**
- Fallback hardcoded sempre presente. Logs `[promptsLoader] source=db`
  ou `source=hardcoded` em cada `getAgentRulesText` (uma vez por
  refresh).
- Seed só insere se a tabela estiver vazia (`COUNT = 0`); nunca
  sobrescreve patch aplicado.
- Apply faz INSERT em `agent_rule_versions` ANTES do UPDATE em
  `agent_rules` — se algo quebrar, histórico é preservado.
- Rollback é uma operação igual ao apply (cria nova versão a partir
  da versão alvo). Nunca perde linhas.
- UI confirma antes de aplicar; mostra diff colorido.

---

### 2026-05-22 — Reordenação de gates no flush + bypass de scope para mídia/contexto

**Decisão.** Corrigir 6 bugs comportamentais do fluxo do agente em 2 PRs
pequenos. Não mexer em duplicação/refactor estrutural neste ciclo
(reservado pra refactor futuro).

**PR 1 — não perder mensagens válidas no flush.**

1. `flushSessionInner` (`server/evolution/webhookEvolution.js`) agora
   checa `ai_disabled`, `reply_cooldown` e `ia_paused` **antes** de
   `drainMessages`. Mensagens permanecem no buffer; o próximo tick
   reprocessa quando o gate liberar. Logs trocam `discarded:N` por
   `held … | pending:N`.
2. `endAgentQueueSession` (`server/agentQueueSession.js`) só chama
   `clearMessages` se `flushSession` realmente consumiu o buffer.
   Quando o flush é "held" (claim ocupado em outra réplica, cooldown,
   pausa), o buffer é preservado pro próximo tick processar — e o log
   imprime `flush_skipped=...`.
3. `isAtendimentoIaPaused` permanece como rede de segurança em
   `agentRunner.js`, mas o webhook passa `skipPauseCheck: true` (gate
   já foi checado antes do drain), evitando round-trip extra.
4. `AGENT_REPLY_COOLDOWN_SEC=0` agora **desliga** o cooldown
   (`server/replyCooldown.js`). Default continua 45s. Log do flush
   inclui segundos restantes.

**PR 2 — scope classifier mais preciso.**

5. `classifyMessageScope` (`server/ai/scopeClassifier.js`) ignora
   mensagens `messageIsInboundMediaPlaceholder` (áudio/imagem) —
   tratamento fica nos fluxos especializados (
   `inscricaoAceitePagamentoFlow`, transcrição). Evita recusa indevida
   quando o status de inscrição está stale.
6. `runAgent` (`server/ai/agentRunner.js`) trata `isGreetingOnly` logo
   após carregar histórico, **antes** das chamadas a Kommo (sum_curso),
   pós-form, course level e auto-handoff. Saudação contextual continua
   funcionando porque o histórico já está disponível.
7. Reforço opcional `SCOPE_BLOCK_REQUIRE_NO_CONTEXT=true`: quando
   ligado, recusa de fora_escopo é suprimida se houver contexto ativo
   (curso em discussão, tópico ativo). Default false — ligar
   gradualmente após monitorar logs.

**Contexto.**
- Logs anteriores mostravam mensagens descartadas pelo flush (gates
  aplicados depois do drain).
- `endAgentQueueSession` apagava buffer mesmo quando o flush não tinha
  conseguido processar — perda definitiva.
- Mídia inbound chegava ao scope classifier e disparava recusa quando
  o fluxo de aceite/pagamento não pegava.
- Saudações simples consumiam I/O caro (Kommo, inscrição) sem
  necessidade.

**Alternativas descartadas.**
- *Refatorar a unificação de gates em uma camada só.* Mudança maior
  (estado da IA, pausa, cooldown vêm de fontes diferentes); fica pra
  futuro PR arquitetural.
- *Remover totalmente o check de `isAtendimentoIaPaused` de
  `agentRunner.js`.* Quebraria callers alternativos (playground em
  `server.js POST /api/agent/run`). Solução: flag `skipPauseCheck`
  opcional, default false.
- *Ligar `SCOPE_BLOCK_REQUIRE_NO_CONTEXT` por default.* Pode suprimir
  recusas legítimas em borderline; preferimos observabilidade primeiro
  (default false).

**Impacto.**
- Arquivos modificados:
  - `server/evolution/webhookEvolution.js` — reordenar gates, troca
    log discarded→pending, importa `getMessages`,
    `getReplyCooldownRemainingMs`.
  - `server/agentQueueSession.js` — guard de `clearMessages` baseado
    em retorno do `flushSession`.
  - `server/replyCooldown.js` — `AGENT_REPLY_COOLDOWN_SEC=0` desliga,
    nova fn `getReplyCooldownRemainingMs`, `isReplyCooldownDisabled`.
  - `server/ai/agentRunner.js` — `skipPauseCheck`, isGreetingOnly
    movido para antes dos flows de Kommo/inscrição,
    `SCOPE_BLOCK_REQUIRE_NO_CONTEXT` opcional.
  - `server/ai/scopeClassifier.js` — bypass para mídia inbound.
  - `.env.example` — documenta novas envs.
- Comportamento esperado: nenhum descarte silencioso. Toda mensagem
  válida vai ou virar resposta ou permanecer no buffer pra próximo
  tick. Logs ganham `held` + `pending:N` + `flush_skipped=...`.

**Salvaguardas.**
- `SCOPE_BLOCK_REQUIRE_NO_CONTEXT=false` por default (mudança
  observável; ativar manualmente após monitorar).
- `flushSession` retorna `{skipped:'reply_cooldown', remainingMs}` —
  o caller (`agentQueueSession`) detecta e preserva o buffer.
- Sintaxe de todos os arquivos validada com `node --check`.
- Validação funcional manual (cooldown, pausa, mídia sem texto,
  follow-up de curso, fora-de-escopo no início) precisa rodar com
  lead de QA após o deploy — passos descritos no plano original.
