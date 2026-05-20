# AGENT — Decisões arquiteturais

Registro cronológico de decisões que afetam padrão, dependências ou
estrutura do projeto. Conforme `Governança de Tarefas`, tarefas
complexas devem ser registradas aqui após aprovação do usuário.

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
