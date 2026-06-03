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

### 2026-06-03 - Regra 24: desconto por pagamento antecipado — informar 1× junto com o valor — IMPLEMENTADO

- **Decisão / desfecho**
  - Nova regra de atendimento (id 24) governando QUANDO enviar o "Plano de Benefício para
    Pagamento Antecipado Facultativo" (70%/50%/20% conforme o dia do mês) já cadastrado em
    `grad_info`/`pos_info`.
  - Comportamento: enviar o benefício **junto com o valor do curso**, mas **apenas uma vez por
    conversa** (na primeira vez que citar preço); ou sempre que o candidato **perguntar
    diretamente** sobre o desconto (aí pode repetir). Nas demais menções a preço, não repetir.
  - Aplicado em 3 lugares para consistência: hardcoded (`server/ai/promptsLoader.js`, fallback),
    `AGENT_RULES_CATALOG` (id 24) e tabela `agent_rules` do DB (id 24, v1 + espelho em
    `agent_rule_versions`, source `seed`). O prompt ATIVO vem do DB — por isso o seed é
    obrigatório. Script idempotente/reversível: `scripts/add-rule-pagamento-antecipado.mjs`.
- **Contexto**
  - `composeOverrideFromDB` monta o prompt ativo = cabeçalho hardcoded + corpos das regras do DB
    (ordenados por id). Regra só vale se existir no DB.
- **Alternativas descartadas**
  - Embutir na regra 15 (preços): rejeitado — regra dedicada é mais fácil de avaliar/versionar
    e de rastrear pelo avaliador por rule_id.
  - Enforcement determinístico em código (contar envios no histórico): rejeitado por ora — o
    pedido é uma "regra de atendimento" (prompt); o agente usa o histórico (regra 5) para não repetir.
- **Impacto**
  - Durante a implementação detectou-se que a regra 23 (LGPD) estava em hardcoded + catálogo
    mas **nunca havia sido semeada no DB** → estava inativa no prompt real. Com aprovação do
    usuário, a LGPD (23) foi semeada no DB (`scripts/add-rule-lgpd.mjs`, v1, source `seed`).
    DB agora contíguo: ids 1–24.
  - Reversão: `DELETE agent_rules?id=eq.24` (+ `agent_rule_versions?rule_id=eq.24`) e remover o
    bloco "24." do hardcoded/catálogo. (LGPD/23 idem via `id=eq.23`.)

---

### 2026-06-03 - RAG preços por modalidade (EAD + Semipresencial) — IMPLEMENTADO

- **Decisão / desfecho**
  - Fonte de verdade: planilha oficial "cursos Sumaré.xlsx" (41 graduações, 34 pós).
    Cada curso tem **uma única modalidade** (EAD ou Semipresencial) — não é multi-modalidade
    por curso. Pós é tudo EAD.
  - `grad_preco` (41 linhas) atualizado: `modalidade: EAD|Semipresencial` + grau + duração +
    preços novos. 18 graduações migraram EAD→Semipresencial (Arquitetura, Biomedicina,
    Engenharias, Farmácia, Fisioterapia, Nutrição, Ed. Física Bach/Lic, Geografia, História,
    Letras, Matemática, Pedagogia, Saneamento, Serviço Social). Corrigido id=168 (nome_curso
    corrompido → "Sistemas de Informação").
  - `pos_preco` (34 linhas) atualizado: preços (vários 187/623 → 191/637) + `modalidade: EAD`.
  - `grad_info`: 18 linhas semipresenciais tiveram `modalidade` trocada para Semipresencial.
  - **Removidos 7 cursos de pós** fora da planilha (Ensino Lúdico, MBA Gestão de Projeto,
    MBA Negócios e Vendas, Ciência de Dados, MBA Controladoria, MBA Gestão de Negócios e
    Estratégia, MBA Logística Lean) em `pos_preco` e `pos_info`. Backup em
    `scripts/backup-pos-removidos-*.json`.
  - Tudo re-embeddado (text-embedding-3-small / 1536 dims).
  - Código: `normalizeModalidadeForSumare`/`normalizeModalidadeInText`
    (`libShared/knowledgeRowFormat.js`) NÃO forçam mais Presencial/Semi → EAD (só padronizam
    grafia para "Semipresencial"). Prompts EAD-only ajustados no hardcoded
    (`server/ai/promptsLoader.js`) E no DB (`agent_rules` regras 2, 6, 15, 18 → v2).
  - Script de migração: `scripts/apply-cursos-sumare.mjs` (mapa explícito por id, `--dry-run`).
    O legado `update-precos-sumare-rag.mjs` foi marcado DEPRECADO (exige `--force`) para não
    reverter a modalidade.

- **Contexto / evidências**
  - Site multi-modalidade (`/graduacao/{ead|semi|presencial}/{curso}`) mas preços via JS
    (não raspáveis) → usamos a planilha oficial.
  - `sumare_captacao_curso`: Presencial=0 (sem código de matrícula) → presencial fica de fora.
  - Validado: Farmácia volta Semipresencial R$227 (cheio 757); Administração EAD 107/357.

- **Alternativas descartadas**
  - Presencial agora: sem código de matrícula. 1 linha por curso+modalidade: desnecessário
    (cada curso tem 1 modalidade na planilha). Raspar preço do site: inviável (JS).

- **Impacto / pendência**
  - Mudanças de DADOS (tabelas RAG) e de REGRAS (agent_rules via cache TTL) já valem em
    produção. As mudanças de CÓDIGO (`knowledgeRowFormat.js` e header de `promptsLoader.js`)
    exigem **deploy** para a normalização parar de exibir "EAD" nos semipresenciais.

---

### 2026-06-03 - RAG: plano de pagamento antecipado em grad_info / pos_info

- **Decisão**
  - Adicionada **1 linha nova em `grad_info` e 1 em `pos_info`** (id=125 e id=124)
    com o "Plano de Benefício para Pagamento Antecipado Facultativo" (descontos
    70%/50%/20% conforme o dia do mês; sem desconto após o dia 10), para o agente
    responder quando o candidato perguntar **quais dias pode pagar a mensalidade**.
  - Conteúdo geral (não por curso), com cabeçalho de palavras-chave para retrieval.
    Embedding gerado com o mesmo modelo do RAG (`text-embedding-3-small`, 1536 dims).
  - Script reutilizável: `scripts/add-plano-pagamento-info.mjs` (`--dry-run`,
    idempotente via `metadata.topic = 'pagamento_antecipado'`).

- **Contexto**
  - `grad_info`/`pos_info` são tabelas RAG (content + embedding) consultadas por
    `match_grad_info`/`match_pos_info`. O `queryClassifier` roteia perguntas de
    pagamento para `ambiguous` (busca as 4 tabelas) ou `mista` (inclui `*_info`),
    então a informação em `*_info` é alcançável. Validado: as linhas novas voltam
    em 1º lugar (similarity ~0.64–0.70 vs ~0.30–0.50 dos cursos).

- **Alternativas descartadas**
  - Anexar o texto a cada uma das 41 linhas de curso e re-embeddar tudo: polui os
    embeddings por curso e é redundante para uma informação geral.
  - Colocar em `*_preco`: o usuário pediu `*_info`; o roteamento já cobre `*_info`.

- **Impacto**
  - Aditivo e reversível (basta apagar as linhas com `metadata.topic=pagamento_antecipado`).
    Sem mudança de código do agente; só dado de RAG.

---

### 2026-06-03 - Agente assume a função do n8n após o formulário (parse + card + matrícula)

- **Decisão / desfecho**
  - O agente passa a cumprir, **sem n8n**, o que o workflow `log_inscricao_feita_sum`
    fazia ao receber o Meta Flow (`nfm_reply`): parsear o `response_json`, AJUSTAR os
    dados e preencher o card do Kommo, depois seguir para a matrícula.
  - Novos módulos:
    - `libShared/metaFlowFormParser.js` — porte fiel do node "Code in JavaScript3":
      `parseMetaFlowResponseJson` + helpers de normalização (`normalizeBrazilPhone`
      → DDI 55; `formatDateToDDMMYYYY`; `mapSexo` enum→texto; CPF só dígitos).
      Mapeia por **field_id embutido na chave** (`<Tipo>_<fieldId>_<idx>`) — resiliente
      a mudança de tipo/índice. IDs: 1475361 nome, 1475363 cpf, 1475397 telefone,
      1475395 email, 1475971 sexo, 1475467 nascimento.
    - `server/metaFlowFormSync.js` — `applyMetaFlowFormToKommo`: PATCH dos campos
      personalizados (nome/cpf/telefone/nascimento/sexo) + move o lead para
      pipeline 13756724 / status 106804680 (inscrição) + cria a nota de auditoria
      no MESMO formato do n8n (CPF/DATA/NOME/EMAIL/TELEFONE/SEXO). Dedupe em memória
      (10 min) evita PATCH/nota duplicados em retries.
  - Ligação no `agentRunner.js`: ao detectar o `nfm_reply` cru
    (`messageIsMetaFlowFormReply`), sincroniza o Kommo ANTES do pipeline pós-form.
    O pipeline existente (`fetchLeadFormSnapshot` → `detectFormSumarRecebidoNoKommo`
    → `stepMatriculaPosForm`) então lê o card já preenchido e segue para a matrícula.

- **Contexto (evidências)**
  - Com o n8n desativado (webhook Meta repontado p/ o agente), ninguém preenchia o
    card após o formulário; o snapshot vinha vazio e o pós-form não avançava.
  - O webhook Meta já entrega o reply no buffer como `[FORMULARIO SUMAR]: {response_json}`
    (`server/whatsapp/metaWebhook.js`), mas o `parseFormDataNoteFields` só lia o
    formato de NOTA (CPF:/NOME:), não o `response_json` (chaves `TextInput_<id>`).
  - O e-mail vai SÓ na nota (igual ao n8n, que não gravava e-mail no card); o snapshot
    já lê e-mail da nota via `enrichSnapshotFromFormNote`.
  - Curso/polo/tipo_ingresso continuam vindo da conversa (sum_Curso + passo de polo
    pré-form), não do formulário — idêntico ao n8n.
  - Parser validado com o sample do `pinData` do workflow.

- **Alternativas descartadas**
  - Reativar o n8n — contraria a decisão de ter o agente como único receptor (evita conflito).
  - Casar a string literal completa da chave do Flow — frágil a mudanças de tipo/índice;
    optou-se por mapear pelo field_id numérico embutido.

- **Impacto**
  - Funil/IDs configuráveis por env (`AGENT_FUNNEL_PIPELINE_ID`,
    `AGENT_FUNNEL_STATUS_INSCRICAO`, `KOMMO_FIELD_FORM_*_ID`); defaults = os do n8n.
  - Move o lead para "inscrição" automaticamente ao receber o formulário — coerente
    com a regra de o agente atender em Atendimento + inscrição.

---

### 2026-06-03 - Fix: curso errado no card (sum_Curso) por palavra-chave incidental na descrição

- **Decisão / desfecho**
  - Corrigido `extractDiscussedCourseFromHistory` (`libShared/conversationContextHeuristics.js`)
    para extrair o curso pelo **enunciado do tópico** ("curso de [graduação/tecnólogo] em X")
    e, no fallback, varrer **só a 1ª frase** do texto do assistente — não a descrição inteira.
    A captura é normalizada para o nome canônico de curso conhecido.
  - Reforçada a regra #17 do prompt (`promptsLoader.js`) com o padrão exato
    "Quer mais detalhes ou informações sobre outro curso?" → "sim" → perguntar qual,
    NUNCA redespejar a descrição do curso atual.

- **Contexto (evidências)**
  - Lead real #23877563 (Leandra, +5511910144847): card `sum_Curso` mudou Direito → **Administração**
    enquanto a conversa era sobre **Redes de Computadores**. O agente também **repetiu**
    a mesma resposta de Redes ao receber "sim".
  - Causa raiz do curso errado: ao responder "sim", `detectCursoConfirmadoPeloLead` chamava
    `extractDiscussedCourseFromHistory`, que caía no fallback `extractCursoAreaFromText` e
    varria a descrição inteira do curso de Redes, casando a palavra "administração" presente
    em "…foco em **administração** e segurança de redes corporativas…". "Administração" vem
    antes de "Redes de Computadores" na lista `CURSO_PATTERNS`. Reproduzido com os dados reais.
  - Causa da repetição: violação da regra #17b do prompt (LLM redespejou a info em vez de
    perguntar qual opção). Reforço de prompt aplicado; guard determinístico fica como opção.

- **Alternativas descartadas**
  - Reordenar `CURSO_PATTERNS` — não resolve (a palavra ainda aparece na descrição).
  - Guard determinístico anti-repetição no `agentRunner` — adiado (maior risco de falso
    positivo); prompt reforçado primeiro.

- **Impacto**
  - Heurística de "curso em discussão" usada em vários pontos (sum_Curso, continuação de
    assunto). Agora prioriza o enunciado do tópico e o nome canônico, evitando falsos positivos.

---

### 2026-06-02 - Diagnóstico: chats WABA da conta `academicosoead` não são legíveis (dispatcher é de OUTRA conta)

- **Decisão / desfecho**
  - **Mantido `KOMMO_INBOUND_POLL_MODE=notes`** em produção. Uma troca experimental
    para `dispatcher` foi feita e **revertida** no mesmo dia ao descobrir que o
    `banco-kommo-dispatcher` sincroniza **outra conta Kommo**, não a do agente.
  - Não há mudança de código. Decisão de configuração/arquitetura pendente de
    definição do canal correto (ver abaixo).

- **Contexto (evidências)**
  - Lead real #23583611 (conta `academicosoead.kommo.com`, account_id 31697347,
    pipeline 13756724 etapa Atendimento, com telefone +5511993537209) não recebia
    atendimento. Funil/allowlist/scheduler estão corretos.
  - O talk dele é `origin='waba'` ("Suporte ao Aluno - Sumaré EaD",
    chat_id `bb2f4644…`). As mensagens "oi" de hoje **não existem** como
    `incoming_chat_message` nem como nota v4 (só um `entity_direct_message` antigo de
    março). Texto, se existir, está só na camada Chats/Amojo — e Amojo não está
    configurado (`KOMMO_CHANNEL_SECRET/SCOPE_ID` ausentes).
  - `banco-kommo-dispatcher`: saudável (~1,8M msgs, ~83k chats), mas
    `by-lead`/`by-chat`/`sync-chat` retornam **0** para os 3 leads do funil do
    agente. Sessão logada como `felipe.nolasco@cruzeiroead.com.br`
    (LAST_PLACE_DEALS pipeline 5481944). Leads que o dispatcher possui (ex.:
    21317945, 20885141) retornam **HTTP 204 (inexistentes)** na conta do agente →
    **o dispatcher é de outra conta** (comercial cruzeiroead), não `academicosoead`.
  - Conclusão: para os leads do agente, **nenhum** caminho lê esse canal WABA hoje
    (Evolution só cobre a instância `SUMARE_IA`; poll `notes` não vê WABA do Kommo;
    Amojo não configurado; dispatcher é de outra conta).

- **Alternativas em aberto (a decidir com o produto)**
  - (a) Conectar o número "Suporte ao Aluno - Sumaré EaD" à instância Evolution
    (`SUMARE_IA`) → webhook passa a entregar inbound direto ao buffer.
  - (b) Configurar Amojo da conta `academicosoead` (`KOMMO_CHANNEL_SECRET` +
    `KOMMO_CHANNEL_SCOPE_ID`) e usar `KOMMO_INBOUND_POLL_MODE=amojo`.
  - (c) Apontar um dispatcher para a conta `academicosoead` (o atual é de outra).
  - (d) Usar o webhook nativo da Meta Cloud (já implementado) se esse número estiver
    no app Meta do projeto.
  - Hipótese a validar: o "oi" pode ter sido digitado no widget de chat do Kommo
    (Salesbot), e não enviado como WhatsApp real do telefone do contato — nesse caso
    nenhum webhook dispara. Testar com mensagem real do telefone do cliente.

- **Impacto**
  - Produção segue em `notes` (estado anterior, sem regressão). O atendimento por
    Evolution (`SUMARE_IA`) não depende disso e continua funcionando.

---

### 2026-06-02 - Funil da IA passa a atender também a etapa "inscrição" (não "aguardando pagamento")

- **Decisão**
  - `server/kommoAgentFunnelGate.js`: o funil fixo da IA deixa de ser um único
    status e passa a ser uma lista `AGENT_FUNNEL_STATUS_IDS = [106140284
    (Atendimento), 106804680 (inscrição)]`. `leadMatchesAgentFunnel` e
    `resolveAgentFunnelFromEnv` usam a lista; o scheduler/listador já iteravam
    `statusIds`, então nenhuma outra mudança foi necessária.
  - "aguardando pagamento" (106426128) **continua fora** do funil — quando o
    candidato envia o comprovante, `tryHandleMatriculaAceitePagamentoFlow` move o
    lead para essa etapa e pausa a IA (`atendimento_ia=pause`).

- **Contexto**
  - Após a matrícula o lead fica na etapa "inscrição" (aguardando aceite/contrato
    e o comprovante). Com o funil antigo (só "Atendimento"), o scheduler/poll não
    processava o lead nessa etapa → a IA ficava muda justamente quando precisava
    encaminhar dados e receber o comprovante. Pedido do produto: atender em
    "inscrição" até o comprovante; parar em "aguardando pagamento".

- **Alternativas descartadas**
  - Mover o lead de volta para "Atendimento" a cada inbound: exigiria automação
    externa (n8n) e mexer no estágio do CRM a cada mensagem — frágil e ruidoso.
  - Tornar o funil configurável por env: o arquivo é trava fixa de propósito
    (env divergente é ignorado com warn); manter os IDs no código preserva esse
    contrato e evita drift de configuração entre ambientes.

- **Impacto**
  - A IA conversa em "Atendimento" e "inscrição"; ao receber o comprovante o lead
    vai para "aguardando pagamento" e a IA não atende mais ali (handoff humano).
  - Vale para TODOS os leads do pipeline 13756724. Requer deploy em produção.

---

### 2026-06-02 - Código de curso só é "código pronto" se tiver formato token_token (ex.: GAST_EAD)

- **Decisão**
  - Em `resolveCursoCodigo` (`server/sumareCaptacaoClient.js`) e
    `resolveCursoCodigoFromDb` (`server/sumareCaptacaoCursoStore.js`), o atalho que
    considera o valor "já um código de API" passou de `/^[A-Z0-9_]{4,32}$/i` para
    `/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/i` — exige o formato real de código (token_token,
    ex.: `GAST_EAD`, `ADM_EAD`). Nomes humanos de curso ("Gastronomia",
    "Administração") deixam de casar e passam a cair no mapa estático e no catálogo
    `sumare_captacao_curso` (Supabase), que resolve o código correto.

- **Contexto**
  - Matrícula do lead `#23841399` (curso "Gastronomia") falhava com HTTP 500 da API
    de Captação: `Cannot insert the value NULL into column 'CANDIDATO'
    (LYCEUM.dbo.TSCU_INSCRICAO_FINANCEIRO_CANDIDATO)`. O snapshot do Kommo estava
    completo e válido (nome, CPF, e-mail, data nasc., sexo). A causa era o curso:
    `resolveCursoCodigo` casava a palavra "Gastronomia" no regex permissivo e
    devolvia o literal `GASTRONOMIA` (inexistente no Lyceum), pulando inclusive a
    consulta ao Supabase. Diagnóstico confirmado: `GASTRONOMIA`→500;
    `GAST_EAD`→200 OK (candidato gerado, página Contrato).

- **Alternativas descartadas**
  - Adicionar "gastronomia" ao mapa estático `CURSO_NOME_TO_CODIGO`: resolveria só
    esse curso; o regex permissivo continuaria mascarando outros nomes presenciais.
  - Validar o código contra o catálogo antes de enviar: mais robusto, porém maior;
    o catálogo Supabase já é a fonte de verdade e passa a ser consultado com o fix.

- **Impacto**
  - "Gastronomia" e demais nomes humanos passam a resolver pelo catálogo
    (`GAST_EAD` etc.); a matrícula da Sumaré deixa de receber código inválido.
  - Valores que JÁ são código (`GAST_EAD`) continuam aceitos sem ida ao catálogo.
  - Requer deploy em produção para o agente resolver automaticamente; o lead
    `#23841399` foi matriculado manualmente (candidato `2026700000004826`, link de
    contrato enviado por WhatsApp) para validar o fluxo ponta a ponta.

---

### 2026-06-02 - Formulário vazio (n/a) não dispara matrícula nem pausa a IA

- **Decisão**
  - **A) Gate de detecção por dados reais** (`server/inscricaoPostFormPipeline.js`,
    `detectFormSumarRecebidoNoKommo`): uma nota com ESTRUTURA de formulário
    (`CPF:`/`NOME:`/`EMAIL:`…) só conta como "formulário recebido" se o
    `fetchLeadFormSnapshot` do Kommo tiver os campos obrigatórios preenchidos
    (`validateFormSnapshot`, que trata `n/a`/"não informado"/vazio como ausente).
    O marcador real do Flow ("Flow responses received") continua detectando.
  - **B) Rede de segurança anti-pause espúrio** (`server/dadosClienteStore.js`,
    `decideHoldOnIaPause`/`shouldHoldOnIaPause`): se o lead está `atendimento_ia=pause`
    mas o `inscricao_form_status='aguardando_form_sumar'`, o pause é considerado
    indevido (a IA deveria estar conversando nesse estágio) — limpa o pause
    (`await`, antes do gate secundário do `agentRunner`) e deixa o atendimento seguir.
  - **Higiene de buffer** (`server/kommoInboundPoll.js`, `classifyInboundNote`):
    nota de dados de formulário (estrutura, sem marcador de Flow) é DADO de CRM,
    não mensagem do candidato — passa a ser `skip` (`form_data_note`) e não entra
    no buffer (evitava a IA responder a "CPF: n/a …").

- **Contexto**
  - Lead `#23841399` ficou sem resposta: o bridge/poll gravou nota de formulário
    com todos os campos `n/a`; a heurística tratou como submissão real → pipeline
    pós-formulário chamou a API de Captação → falhou (sem CPF/nome) →
    `pauseAtendimentoIa` + `distribuir_consultor`. Toda mensagem seguinte caía no
    gate de pause = silêncio. A matrícula lê os dados dos campos do Kommo
    (`fetchLeadFormSnapshot`), não do texto da nota.

- **Alternativas descartadas**
  - Guard puramente textual ("tudo n/a") em `messageLooksLikeFormSumarResponse`:
    frágil (o telefone vem preenchido) e não reflete a fonte real da matrícula
    (campos do Kommo). Optou-se por validar o snapshot.
  - Auto-despausar em qualquer estágio: arriscado (reabriria handoffs legítimos
    em `aguardando_aceite`/`distribuir_consultor`). Restringiu-se a
    `aguardando_form_sumar`.

- **Impacto**
  - Formulário incompleto não pausa mais a IA nem estrangula o lead; a matrícula
    só é acionada quando os dados reais chegam aos campos do Kommo.
  - **Dependência de origem (C, fora deste repo):** a matrícula só efetiva quando
    o Meta Flow → n8n gravar CPF/nome/email/curso nos campos do lead no Kommo,
    com nomes compatíveis com `FIELD_ALIASES` (`server/inscricaoKommoFields.js`):
    nome (`sum_nome`/id 304628), e-mail (`e-mail`/`sum_email`), CPF (`cpf`/`documento`),
    curso (`curso inscrição`/`sum_curso`/`código curso`). Sem isso, não há dado
    para matricular. Obrigatórios configuráveis via `INSCRICAO_FORM_REQUIRED_FIELDS`
    (default `nome,email,cpf,curso_inscricao`).

---

### 2026-06-02 - Snapshot do formulário com fallback pela nota do n8n + e-mail estrito

- **Decisão**
  - `fetchLeadFormSnapshot` (`server/inscricaoKommoFields.js`) passou a preencher
    campos vazios (`nome/email/cpf/data_nasc/sexo`) a partir da última NOTA de
    dados do formulário (escrita pelo n8n no Kommo), via
    `parseFormDataNoteFields` (`libShared/inscricaoFormHeuristics.js`). Só
    preenche o que está ausente no campo personalizado; nunca sobrescreve.
  - Validação de e-mail estrita: e-mail sem formato válido (ex.: `@` corrompido
    na nota — `...0204@gmail.com` virou `...02042gmail.com`) é tratado como
    ausente (`validateFormSnapshot` + parser). Evita matricular com e-mail
    inválido e o consequente pause indevido.

- **Contexto**
  - O n8n passou a gravar os dados do Flow nos campos do Kommo (`sum_Nome`,
    `sum_CPF`, `sum_Data Nascimento`, `Sexo`, `sum_Curso`=Gastronomia) e numa
    nota. Porém o `sum_Email` ficou vazio (e-mail só na nota) e a nota corrompe
    o `@`. Sem o fallback, o snapshot reprovava por e-mail e a matrícula não
    disparava.

- **Alternativas descartadas**
  - Resolver só no n8n (gravar `sum_Email`): correto, mas deixa o agente frágil a
    qualquer campo não replicado. O fallback pela nota torna a leitura resiliente.
  - Aceitar o e-mail corrompido: matricularia com e-mail inválido → rejeição da
    API de Captação → pause/handoff (o problema que estamos eliminando).

- **Impacto**
  - O agente reconhece o formulário e dispara a matrícula automaticamente assim
    que um e-mail VÁLIDO chegar (campo `sum_Email` ou na nota com `@` íntegro).
  - **Pendência de origem:** corrigir no n8n o e-mail — gravar em `sum_Email` e/ou
    não corromper o `@` na nota. É o único dado que ainda falta para este lead.

---

### 2026-06-02 - Webhook nativo WhatsApp Cloud API (Meta) sem Evolution

- **Decisão**
  - Receber as mensagens do candidato **direto da Meta** via webhook nativo,
    eliminando a Evolution como intermediário do inbound (causa de quedas em
    produção). Novas rotas em `server.js`:
    `GET /api/whatsapp/webhook` (verificação `hub.challenge`) e
    `POST /api/whatsapp/webhook` (eventos).
  - Módulos novos e isolados:
    - `server/whatsapp/metaWebhook.js` — verify token, validação de
      assinatura `X-Hub-Signature-256` (HMAC com `WHATSAPP_APP_SECRET`),
      parser do payload Meta (`entry[].changes[].value.messages[]`) para
      texto/áudio/imagem/botão/interactive(Flow)/documento/vídeo/localização,
      e push no MESMO buffer (`pushMessage`). Só BUFFERIZA; o agentScheduler
      responde (idêntico ao webhook Evolution).
    - `server/whatsapp/metaMedia.js` — download de mídia em 2 etapas
      (`GET /<media_id>` → URL temporária → bytes), devolvendo base64 para
      reaproveitar Whisper/Vision (`transcribeAudioBase64`/`analyzeImageBase64`).
  - `express.json({ verify })` passou a guardar `req.rawBody` (bytes crus
    necessários para o HMAC da assinatura).
  - Marcadores de áudio/imagem no buffer são idênticos aos do caminho
    Evolution, para o prompt (regra de mídia) reagir igual.
  - **Rollout seguro**: a rota fica INERTE até `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
    ser configurado (GET 403, POST ignora). Evolution continua como fallback.
    `WHATSAPP_INGEST_PHONE_ALLOWLIST` limita a fase de teste a números
    específicos. Outbound, "digitando..." e mídia já eram Cloud API direto.

- **Contexto**
  - A conexão Meta↔Evolution cai com frequência em produção, deixando o
    agente sem receber mensagens. O envio já era Cloud API direto (modo
    `cloud`), então o número já é Meta Cloud — a Evolution só fazia ponte.
  - A Cloud API não oferece "puxar" inbound por polling próprio; o caminho
    direto é o webhook nativo (ou, alternativamente, o poll do Kommo já
    existente).

- **Alternativas descartadas**
  - Poll do Kommo (`KOMMO_INBOUND_POLL_MODE`): funciona sem Evolution e sem
    webhook, mas adiciona latência, depende da integração nativa do Kommo e
    não traz mídia de forma confiável. Mantido como fallback secundário.
  - Estabilizar a Evolution: não resolve a causa (a ponte Meta↔Evolution).

- **Impacto**
  - Inbound em tempo real, sem intermediário; some a gambiarra da "ponte
    Cloud" (`contacts.upsert` sem telefone) que descartava mensagens.
  - Migração faseada: código deployável sem efeito até configurar as envs +
    Callback URL no painel Meta. Rollback = remover o verify token / reapontar
    URL para a Evolution.
  - Risco concentrado no download de mídia (mecanismo novo) — validar com
    número de teste (texto → áudio → imagem → resposta) antes do corte.

---

### 2026-06-02 - Ambiente de teste do agente sem Evolution (/api/test/inbound)

- **Decisão**
  - Novo endpoint `POST /api/test/inbound { phone, message, send?, leadId? }`
    (`server.js`) que injeta uma mensagem como se viesse do lead e roda o
    caminho REAL `flushSession` (mesmo do scheduler) — exercitando todas as
    funções do agente (inscrição, polo, distribuir, captação, telemetria)
    sem depender do inbound da Evolution.
  - `flushSessionInner` ganhou as flags de teste em `opts`:
    `test:true` (ignora gates ai_disabled / reply_cooldown / ia_paused) e
    `suppressWhatsapp:true` (não envia no WhatsApp, só devolve a reply;
    também não re-enfileira o turno). `skipFunnelGate` já existia.
  - Restrito à allowlist `TEST_INBOUND_PHONES` (CSV de dígitos; vazio =
    só `5511944690752`).
  - UI: Playground ganhou o modo "Teste real" (`src/components/Playground.jsx`)
    com toggle "Responder no WhatsApp real" (send) vs "só na tela" (suppress).
  - CLI: `scripts/test-inbound.mjs "<msg>" [telefone] [leadId] [--no-send]`.

- **Contexto**
  - A ponte Meta Cloud → Evolution descarta mensagens do candidato
    (`contact_skip_no_remote_jid`): o `contacts.upsert` chega sem o telefone
    do lead, então o inbound não entra no buffer e o agente fica mudo.
  - Enquanto a ponte não é corrigida/deployada, era preciso um canal de
    teste confiável para um número específico que exercite o agente inteiro.

- **Alternativas descartadas**
  - Reusar só o `/api/playground/flush`: roda `runAgent` mas não passa pelo
    `flushSession` real (sem funil, sem envio WhatsApp, sem telemetria
    `origem:evolution`), então não reproduz produção.
  - Modo padrão do Playground (browser → OpenAI direto): usa prompt/tools
    simplificados, sem inscrição/polo/CRM — não cobre "todas as funções".

- **Impacto**
  - Teste end-to-end de um número específico sem Evolution, com opção de
    responder de verdade no WhatsApp ou só simular na tela.
  - Risco contido: gates só são ignorados quando `test:true` (exclusivo do
    endpoint) e o endpoint é limitado pela allowlist.

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

---

### 2026-06-02 - Agente como porta principal do inbound (override de webhook na Meta)

- **Decisão**
  - Tornar o **agente a porta principal** de recebimento das mensagens da Meta,
    repontando o **override de webhook no nível do NÚMERO** (`794200977108142`)
    para `https://banco-agente-sumare.6tqx2r.easypanel.host/api/whatsapp/webhook`.
    O override de número tem prioridade sobre WABA e sobre o callback do app, então
    o n8n deixa de receber este número (a ser desativado pelo cliente — só limpeza).
  - Produção: `WHATSAPP_OUTBOUND_MODE=cloud` (respostas direto pela Cloud API,
    sem depender da Evolution) e `WHATSAPP_APP_SECRET` setado com o secret real
    do app `978458407905051` (valida `X-Hub-Signature-256`).
  - Scripts: `scripts/meta-repoint-webhook.mjs agent|n8n|status` (repoint +
    rollback), `scripts/ep-set-env.mjs` (env genérico), `scripts/diag-app-webhook.mjs`
    e `scripts/diag-waba-subscribers.mjs` (diagnóstico de topologia de webhook).

- **Contexto**
  - Diagnóstico definitivo: TODO o inbound do WhatsApp entrava primeiro no **n8n**
    (callback da WABA e override do número apontavam para o n8n), que era o
    roteador único e só repassava alguns leads à Evolution → agente. Por isso
    leads reais do funil (ex.: #23875217, #23583611) não eram atendidos enquanto
    outros (ex.: #23841399) eram. n8n, Evolution e agente usam o MESMO app Meta.
  - Limites rígidos da Cloud API: não há API para "puxar" inbound (só webhook);
    **um callback por objeto/app**; o override do número *substitui*, não soma.
    Logo, "uma camada extra paralela" só com o mesmo app é impossível — exigiria
    um 2º app inscrito na WABA. O cliente optou por agente principal + desligar n8n.

- **Alternativas descartadas**
  - Ajustar a lógica de roteamento dentro do n8n: mais cirúrgico e preservaria
    todas as funções do n8n, mas exigia acesso ao n8n (não disponibilizado).
  - 2º app Meta inscrito na WABA (entrega paralela real): exigia id+secret de um
    app distinto, que não temos.
  - Relay (agente recebe e re-encaminha ao n8n): mantém n8n vivo, mas adiciona
    complexidade; o cliente preferiu desligar o n8n.

- **Impacto**
  - Inbound em tempo real direto Meta→agente; a regra de funil é preservada
    (o agentScheduler só responde leads nas pipelines/status configurados —
    `AGENT_FUNNEL_STATUS_IDS`). Outbound deixa de depender da Evolution.
  - **Ponto único de entrada:** se o agente cair, não há fallback (n8n não recebe
    mais). Mitigação: redeploy estável + rollback imediato via
    `node scripts/meta-repoint-webhook.mjs n8n`.
  - **Validar** com mensagem real do número de teste (texto → áudio → imagem →
    resposta) e confirmar `lastBufferWrite`/`lastSyncOutcome` em
    `GET /api/evolution/health` antes de o cliente desligar o n8n.
  - **Validado em 02/06**: mensagem real do lead #23841399 chegou direto da Meta
    (`event=meta_webhook`, `outcome=buffer_ok`, `5511944690752@s.whatsapp.net`)
    e o agente respondeu. Webhook nativo confirmado em produção.

---

### 2026-06-02 - Desligar o poll de inbound do Kommo (Meta vira fonte única)

- **Decisão**
  - `KOMMO_INBOUND_POLL_ENABLED=false` em produção. Com o webhook nativo da Meta
    repontado para o agente, o poll do Kommo (notes/events) virou redundante.

- **Contexto / causa raiz de um LOOP**
  - O lead #23841399 entrou em loop de handoff: a cada poucos minutos surgia a
    nota `Encaminhamento automático: lead pediu atendimento humano via WhatsApp
    (agente IA).` e o agente respondia "um consultor entrará em contato".
  - Origem: essa nota é escrita pelo PRÓPRIO agente em `distribuirHumanoTool.js`
    (handoff humano) como `note_type:common` SEM o sufixo `EX-<execId>`. O poll
    de **notas** do Kommo não a reconhecia como outbound (o filtro de outbound
    usa o sufixo `EX-`), então re-ingeria a nota como se fosse mensagem do lead
    → novo handoff → nova nota → loop. Confirmado na memória
    (`human: "ola Encaminhamento automático…"`). O loop começou 18:54Z,
    ANTES do repoint, descartando o webhook como causa.

- **Alternativas descartadas**
  - Filtrar no poll as notas autorais do agente (ex.: prefixo "Encaminhamento
    automático"/"Inscrição – salesbot"): trata o sintoma e ainda deixaria o poll
    duplicando mensagens que agora também chegam pela Meta.
  - Adicionar sufixo `EX-` às notas de handoff: arriscado (várias notas/sistemas)
    e não resolve a duplicação Meta×poll.

- **Impacto**
  - Inbound passa a ter **fonte única** (webhook Meta), sem loop e sem
    duplicação. Rollback: `KOMMO_INBOUND_POLL_ENABLED=true` (volta o poll).
  - O problema antigo de mensagens só visíveis no canal nativo do Kommo (amojo)
    deixa de exigir o poll: o webhook Meta recebe todas as mensagens do número.

---

### 2026-06-03 - RESOLVIDO: "NULL CANDIDATO" era código de unidade (polo) errado

- **Causa raiz real (NÃO era bug externo do Lyceum)**
  - O catálogo `libShared/sumarePoloCatalog.js` tinha códigos de `unidade` errados:
    Barra Funda=`ED_SP_P2`, São Miguel=`ED_SP_P1`, Tatuapé=`ED_SP_P3`,
    Santana=`ED_SP_P4`, e um polo inexistente (Pinheiros=`ED_SP_P5`).
  - Esses códigos não têm oferta no Lyceum → o `gerar` retornava HTTP 500
    "Cannot insert NULL into column CANDIDATO".
- **Mapeamento correto (confirmado pela Sumaré em 03/06)**
  - Barra Funda=`ED_SP_P5` · Santo Amaro=`ED_SP_P6` · Tatuapé=`ED_SP_P7` ·
    Santana=`ED_SP_P8` · São Miguel=`ED_SP_P9`. (Pinheiros removido; Santo Amaro
    deixou de ser "polo indisponível".)
- **Validação**
  - `gerarCandidatoIngresso` com `curso=JORN_EAD` e unidade `ED_SP_P5..P9`
    retorna **HTTP 200** para todos. Matrícula de graduação volta a funcionar.
- **Mudanças**
  - `libShared/sumarePoloCatalog.js`: catálogo corrigido + Santo Amaro adicionado.
  - `server/inscricaoPostFormPipeline.js` (`preparePoloStepAfterForm`): passa a
    preferir o código de unidade do catálogo ao valor salvo no Supabase
    (auto-cura leads antigos com código defasado).
  - Lead #23875607 (Tamires): `captacao_unidade` corrigido para `ED_SP_P5`.
- **Pendência**: endereço do polo Santo Amaro (ficou em branco no catálogo).

---

### 2026-06-02 - [SUPERADO] Suspeita de erro externo (Lyceum/Captação) na graduação

- **Sintoma**
  - Candidato preenche o formulário, o agente DETECTA corretamente (eventos de
    campo do Kommo + snapshot válido) e tenta a matrícula, mas o lead trava em
    `inscricao_form_status=distribuir_consultor` + `atendimento_ia=pause` e só
    recebe "Um consultor entrará em contato" em vez de concluir a inscrição.
    Casos: #23875607 (Jornalismo), #23608285 (CAIO).

- **Causa raiz (externa, lado Sumaré)**
  - `GET https://api-captacao.sumare.edu.br/api-ingresso/candidato/gerar`
    retorna **HTTP 500** com:
    `com.microsoft.sqlserver.jdbc.SQLServerException: Cannot insert the value
    NULL into column 'CANDIDATO', table 'LYCEUM.dbo.TSCU_INSCRICAO_FINANCEIRO_CANDIDATO'`.
  - Nossos params são válidos e completos (CPF, e-mail, nascimento, unidade,
    curso). O erro ocorre no INSERT do financeiro do Lyceum — o id do CANDIDATO
    volta NULL no lado deles.

- **Testes feitos (02/06, todos 500 NULL CANDIDATO)**
  - `curso` com/sem EAD: `JORN_EAD`, `JORN`, `Jornalismo`, `Jornalismo EAD`,
    `JORNALISMO`, `JORN_EAD_EAD`.
  - `tipoIngresso`: Vestibular, Vestibular Online/Agendado, Processo Seletivo,
    ENEM, Transferencia, Prova Agendada.
  - `planoPgto`: vazio, `1`, `30`.
  - Outros cursos de graduação: `ADM`, `ADM_EAD`, `ADS_EAD` → mesmo erro.
  - Conclusão: NENHUM parâmetro que controlamos resolve. É falha sistêmica do
    endpoint de graduação. A PÓS funciona porque usa outro fluxo (não passa por
    `gerarCandidatoIngresso`/Lyceum).

- **Decisão**
  - Acionar a Sumaré/Lyceum: confirmar se a oferta/processo seletivo/plano de
    pagamento de graduação EAD está habilitado para inscrição via API e por que
    o `CANDIDATO` retorna NULL no INSERT do financeiro. Sem correção do lado
    deles, o agente continua detectando o formulário e encaminhando ao consultor
    (comportamento de fallback atual, correto).
  - Após a Sumaré corrigir, reprocessar os leads travados com
    `scripts/proceed-inscricao.mjs`.

- **Alternativas descartadas**
  - Variar curso/tipoIngresso/planoPgto no nosso lado: testado, não resolve.
  - Mudar mapeamento de código de curso: o erro é idêntico para todos os códigos.
