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
