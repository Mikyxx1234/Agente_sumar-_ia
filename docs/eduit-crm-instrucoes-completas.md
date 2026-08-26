# Instruções — completar o EduIT CRM para o Agente Sumaré

Data: 2026-08-24  
CRM: `https://crm.eduit.com.br`  
Auth atual: `Authorization: Bearer <API_KEY>` (`eduit_…`)  
Lead de homologação: William **deal #25** (contact #29, WhatsApp `+5511944690752`)

O agente hoje opera no **Kommo**. O EduIT já tem o funil e o WhatsApp nativos. Falta fechar contrato de API + webhooks + templates + campos, e depois trocar o cliente no agente.

Não commitar a API key. Guardar em secret / `.env` local.

---

## 0. Como o agente opera hoje (o que o CRM precisa cobrir)

| Capacidade | Kommo hoje | EduIT agora (probe) |
|---|---|---|
| Listar fila por etapa | `listLeadsByStatus` | `GET /api/deals?stageId=` **OK** |
| Buscar por telefone | `findLeadByPhone` | `GET /api/contacts?search=` **OK** |
| Abrir card | `getLeadById` | `GET /api/deals/{id\|number}` **OK** |
| Mover etapa | `updateLeadPipelineStatus` | `PUT /api/deals/{id} { stageId }` **OK** |
| Motivo de perda | enum `sum_Motivo da perda` | `lostReason` no deal + custom `motivoperda` **parcial** |
| Nota interna / auditoria | `createLeadNote` | `POST /api/deals/{id}/notes { content }` **OK** |
| Ler WhatsApp | notas / dispatcher / Meta | `GET /api/conversations/{id}/messages` **OK** |
| Enviar WhatsApp texto | Cloud API própria | `POST /api/conversations/{id}/messages` **OK** (cuidado: 24h) |
| Enviar template HSM | Cloud API / Kommo | `GET /api/templates` **vazio** |
| Webhook inbound | Meta webhook + poll Kommo | **não existe** (`/api/webhooks` 404) |
| Custom fields write | PATCH field enum | leitura OK, **gravação não persistiu** |
| Salesbot form / matrícula / consultor | bots 49815 / 49813 / 49777 | **não existe** |
| Listar usuários / canais | API Kommo | **401** na key atual |
| PDF / mídia | Cloud API | **não testado / endpoint não encontrado** |

Funil IA (equivalente a travar o scheduler):

- Atende só **Atendimento** + **Inscrição**
- **Aguardando pagamento** só origem Api Sumaré (feature flag)
- **Aguardando Resposta**, **Ganho**, **Perdido**: IA não flusha (exceto scripts manuais)

IDs EduIT já existentes (Pipeline Principal):

| Slug | Nome | CUID stage |
|---|---|---|
| `lead-de-entrada` | Lead de Entrada | `cmt3egueb098fl2015ar3320t` |
| `atendimento` | Atendimento | `cmt38aydx01q5rw01422frucd` |
| `aguardando-resposta` | Aguardando Resposta | `cmt38aydx01q6rw017rg3a84t` |
| `inscricao` | Inscrição | `cmt38aydx01q7rw01w0of9px5` |
| `aguardando-pagamento` | Aguardando pagamento | `cmt38aydx01q8rw010d91vy1t` |
| `fechamento` | Fechamento | `cmt38aydx01q9rw017pcp64ic` |
| `ganho` | Ganho (`isWon`) | `cmt38aydx01qarw01q4he9y9a` |
| `perdido` | Perdido (`isLost`) | `cmt38aydx01qbrw01sd97lahm` |

Pipeline: `cmt38aydx01q3rw01kkpjklmk`

---

## 1. Sprint A — contrato da API (CRM)

Fazer no repositório do EduIT. Aceite: Postman/cURL no deal #25.

### A1. Auth e permissões da API key

1. Key de integração do agente com scopes explícitos (não só `*` opaco):
   - `deals:read/write`
   - `contacts:read/write`
   - `conversations:read`
   - `messages:read/write`
   - `notes:write`
   - `custom_fields:read/write`
   - `webhooks:read/write`
   - `channels:read`
   - `templates:read`
   - `users:read` (responsável)
2. Corrigir **401** em:
   - `GET /api/conversations/{id}` (hoje lista/messages funcionam; detalhe da conversa 401)
   - `GET /api/channels`
   - `GET /api/users`
3. Manter Bearer. Documentar também `X-API-Key` se for o padrão interno — hoje `X-API-Key` devolve `AUTH_REQUIRED` no host EduIT.
4. Rate limit: no mínimo **300 req/min** por key (o scheduler percorre filas). Headers `X-RateLimit-*`.
5. Publicar OpenAPI em `GET /api/openapi.json` (hoje `/docs/api` cai no login HTML).

### A2. Gravação de custom fields (bloqueante)

Causa raiz (corrigida no probe 2026-08-24):

O PUT **funciona**. O body tem que ser **array em `values`**, no mesmo shape do `dealPanelFields` da UI:

```json
PUT /api/deals/{cuid}/custom-fields
{ "values": [ { "fieldId": "...", "name": "polo", "value": "Tatuapé" }, ... ] }
```

Objeto `{ "values": { "polo": "..." } }` responde 200 e **não grava** (é o que testamos antes). Host da UI: `https://frontend-front.v74knz.easypanel.host` (EasyPanel); `https://crm.eduit.com.br` aceita o mesmo contrato.

`GET /api/deals/25` (número) ainda devolve panel vazio; ler/escrever pelo **CUID**.

Contrato real (o que a UI e o outro agente usam):

```http
PUT /api/deals/{cuid}/custom-fields
Content-Type: application/json

{
  "values": [
    { "fieldId": "cmt4cyv21gbyiow016u7zjhl6", "name": "polo", "value": "Tatuapé" },
    { "fieldId": "cmt4cxxs6gbxsow01pf26inmn", "name": "curso", "value": "Pedagogia" }
  ]
}
```

- `{ "values": { "polo": "..." } }` (objeto) = 200 e não grava.
- Array pode ser parcial (só os campos a mudar); faz merge.
- Sempre `id` = CUID do deal, não o número 25.
- Host UI: `https://frontend-front.v74knz.easypanel.host`

### A2.1 Criar negócio pela API (homologado no #80, depois removido)

```http
POST /api/deals            → 201 { id, number, ... }
{ "contactId": "<cuid>", "pipelineId": "<cuid>", "stageId": "<cuid>", "title": "..." }
PUT  /api/deals/{id}/custom-fields   → { values: [ ... ] }
POST /api/deals/{id}/notes           → 201
DELETE /api/deals/{id}               → 200 { ok: true }
```

- Aceita 2 deals no mesmo contato (não deduplica) — o agente precisa checar `GET /api/deals?contactId=` antes de criar.
- `POST /api/leads` = cria/reusa contato+deal (dedupe por telefone); `POST /api/deals` = deal puro num contato existente.
- Se o contato **já existe**, `POST /api/leads` devolve `contactCreated: false` **sem deal** — aí o agente faz `POST /api/deals { contactId, stageId, title }`. Homologado: Kommo #24222675 → contato #75 (já existia, “Keew”) + negócio **#80** em Inscrição.
- Listagem: `GET /api/deals?stageId=&perPage=` devolve `{ items, total, page, perPage }`; `items[].dealPanelFields` vem **sem valores** (só o detalhe por CUID traz).
- Filtros que funcionam: `stageId`, `contactId`, `search`; `GET /api/contacts?phone=5511944690752` acha o contato.

### A3. Motivo de perda alinhado

Dois lugares hoje: `deal.lostReason` (string livre) e custom `motivoperda` (SELECT).

Unificar:

1. `PUT /api/deals/{id}` `{ "stageId": "<perdido>", "lostReason": "Sem Resposta" }`
2. Obrigatório `lostReason` quando `stage.isLost=true` (422 se faltar).
3. Espelhar no custom `motivoperda`.
4. Enum **exato** (mesmas strings do agente):

   - `Sem Resposta`
   - `Sem Interesse`
   - `Interesse futuro`
   - `Matriculado/Concorrente`
   - `Não possui curso`
   - `Contato Inválido` (hoje está `Contato invalido` — padronizar maiúscula)
   - `Blacklist`

5. `GET /api/lost-reasons` listando `{ id, label }`.

### A4. Buscas que o agente usa o tempo todo

| Endpoint | Filtros |
|---|---|
| `GET /api/deals` | `stageId`, `pipelineId`, `status=OPEN\|WON\|LOST`, `contactId`, `search`, `phone`, `updatedSince`, `page`, `perPage` (max 200) |
| `GET /api/contacts` | `search`, `phone` (E.164 ou dígitos), `q` |
| `GET /api/conversations` | `contactId`, `dealId`, `phone`, `channel=whatsapp` |

`phone` deve achar `+5511944690752`, `5511944690752` e `11944690752`.

### A4.1 Mensagens prontas ("/" na UI) — sem trigger de fluxo na API

`GET /api/templates` já lista o modelo (`explicação contrato`, category `agente`, status `DRAFT`, `content` + `attachments[]` com `messageBefore`). Faltam:

1. `GET /api/templates/{id}` — hoje **401** (a lista funciona).
2. **Disparo do fluxo**: `POST /api/conversations/{id}/messages { templateId }` → 400 `Mensagem vazia.` Nenhuma rota de trigger existe (`/templates/{id}/send`, `/send-template`, `/quick-message`, `/flows/run`… todas 404/405). O "/" da UI é montagem no cliente, não um endpoint.
3. **Mídia**: `{ type: "image", mediaUrl, mediaName }` é ignorado — grava como `messageType: text` com o caption. As imagens vistas na conversa (`/api/storage/.../attachments/att_*.png`) só saem pela tela.

Pedido: `POST /api/conversations/{id}/templates/{templateId}/send` que envie a sequência inteira (texto + anexos na ordem, respeitando `messageBefore`), e aceitar `type=image|document` com `mediaUrl` no POST de mensagem.

### A5. WhatsApp — janela 24h, template, mídia

1. `GET /api/channels` — instância Sumaré Licenciado (`+55 11 99242-9307`), status connected, `hasWindowOpen` por conversa.
2. `GET /api/conversations/{id}` — incluir `windowOpenUntil`, `canSendFreeText`.
3. Enviar texto:
   ```json
   POST /api/conversations/{id}/messages
   { "type": "text", "content": "…" }
   ```
   Se janela fechada: **422** `{ "code": "window_closed" }` — **não** enviar como se fosse SENT (hoje o POST de teste retornou SENT mesmo com banner 24h na UI).
4. Templates:
   ```http
   GET /api/templates?status=APPROVED
   POST /api/conversations/{id}/messages
   { "type": "template", "templateName": "bv_sumare_aguard_pgt", "language": "pt_BR", "components": [] }
   ```
5. Mídia (PDF de grade):
   ```json
   { "type": "document", "mediaUrl": "https://…", "filename": "grade.pdf", "caption": "…" }
   ```
6. Idempotência: header `Idempotency-Key` ou `clientMessageId` para o agente não duplicar no retry.

Cadastrar na WABA (Meta) e sincronizar no EduIT no mínimo:

| Nome interno | Uso |
|---|---|
| saudação / retomar atendimento | lead frio, janela fechada |
| `bv_sumare_aguard_pgt` (equivalente) | fila aguardando pagamento |
| follow-up inscrição | form não preenchido |

### A6. Webhooks (bloqueante para a IA em tempo real)

Implementar CRUD:

- `GET/POST/PUT/DELETE /api/webhooks`

Eventos obrigatórios:

| Evento | Quando | Payload mínimo |
|---|---|---|
| `conversation.message_received` | inbound WhatsApp | conversationId, contactId, dealId, phone, text, wamid, timestamp |
| `conversation.message_sent` | outbound | idem + sendStatus |
| `conversation.message_failed` | erro Meta (ex. 3126) | code, error text |
| `deal.stage_changed` | mudança de etapa | dealId, previousStageId, newStageId, slugs |
| `deal.updated` | custom field / owner | dealId, changedFields |
| `deal.won` / `deal.lost` | ganho/perdido | lostReason se lost |
| `contact.created` | lead novo (CTWA / form) | contactId, phone, source |

Assinatura HMAC: header `X-Eduit-Signature: sha256=…`  
Retry 5xx/timeout; desativar após N falhas.  
Dedup: `X-Eduit-Delivery`.

O agente vai apontar `target_url` para o EasyPanel (`/api/eduit/webhook` — a criar no agente).

### A7. Automação no lugar do Salesbot

Não precisa clonar “salesbot Kommo”. Precisa de **ganchos HTTP** que o agente chama:

```http
POST /api/deals/{id}/actions/send-form
POST /api/deals/{id}/actions/distribute-consultant
POST /api/deals/{id}/actions/start-enrollment
```

Comportamento:

1. **send-form** — dispara o WhatsApp Flow / formulário de dados (o que hoje é bot Formulario_Sum / 49815). Resposta: `{ ok, formSentAt, provider }`.
2. **distribute-consultant** — move para fila humana / atribui `ownerId` / abre tarefa. Equivale bot 49777 / 49813 distribuição.
3. Quando o lead **submete o form**, o CRM dispara webhook `deal.form_submitted` com snapshot: cpf, nome, email, dataNasc, curso, polo.

Até o form nativo existir, o webhook pode só relayer o payload do Form Sumaré atual para o mesmo contrato.

### A8. Correções de qualidade vistas no probe

1. `DELETE /api/contacts/{id}` retornou **500** — corrigir (e/ou `POST /api/contacts/{id}/archive`).
2. `GET /api/leads` = **405**; `POST /api/leads` cria contato. Documentar: criar = `POST /api/leads`, listar = `GET /api/deals` + `GET /api/contacts`.
3. Custom `polo` e `curso` estão **TEXT**. Trocar para SELECT (polos: Barra Funda, Santana, Tatuapé, Santo Amaro, São Miguel + EAD se existir) **ou** manter TEXT e o agente grava o nome canônico.
4. Campo extra recomendado no deal (SELECT ou TEXT): `inscricao_form_status` — espelho do Supabase (`aguardando_form_sumar`, `aguardando_aceite_contrato`, `distribuir_consultor`, …). Se não quiser no CRM, o agente continua só no Supabase (aceitável).
5. `ownerId` atribuível via `PUT /api/deals/{id} { ownerId }` + `GET /api/users`.

---

## 2. Sprint B — dados e operação no CRM (UI)

1. Congelar as 8 etapas (não renomear slugs).
2. Etapa **Fechamento**: definir se a IA usa ou se é só humano. Recomendação: IA **não** atende Fechamento (igual pós-comprovante).
3. **Lead de Entrada**: automação “mensagem inbound → mover para Atendimento” **ou** deixar o agente mover no webhook. Preferência: o **agente** move, para respeitar `ia_paused` / consultor.
4. Painel do deal: os 15 campos já existem; garantir que a UI edita o mesmo `name` da API.
5. Tags: `ia-ativa`, `ia-pausada`, `handoff-consultor` (opcional; pause real continua no Supabase).
6. Responsável padrão da IA: usuário “Assistente Sumaré” (bot) para `ownerId` quando a IA pega o card.

---

## 3. Sprint C — alterações no agente (este repositório)

Só depois do Sprint A ter aceite no #25.

1. `server/eduitClient.js` — fetch Bearer, rate limit, os endpoints da tabela acima.
2. Adapter `server/crmAdapter.js` — funções atuais (`findLeadByPhone`, `listLeadsByStatus`, `updateLeadPipelineStatus`, `createLeadNote`, …) apontando EduIT; Kommo vira fallback `CRM_BACKEND=kommo|eduit`.
3. `kommoAgentFunnelGate.js` — slugs/CUIDs EduIT no lugar dos IDs 13756724 / 106140284 / 106804680.
4. `server/sumareLeadFields.js` — escrever via `PUT …/custom-fields`.
5. Inbound: rota `POST /api/eduit/webhook` → `pushMessage` + `flushSession` (substitui Meta-only / poll Kommo).
6. Outbound: `whatsappSender` pode **delegar** ao EduIT `POST …/messages` **ou** continuar Cloud API se o canal EduIT for o mesmo WABA (evitar **dois** envios). Escolher **um** caminho: o CRM é o sender oficial.
7. Salesbot: chamar `POST …/actions/send-form` etc.
8. Env novo: `EDUIT_BASE_URL`, `EDUIT_API_KEY`, `EDUIT_WEBHOOK_SECRET`, CUIDs de stage (ou resolver por slug no boot).
9. Dual-write opcional 1–2 semanas (`CRM_BACKEND=both`) só se ainda houver operação no Kommo.

Não migrar histórico Kommo no dia 1. Novos leads no EduIT; Kommo em leitura até zerar a fila velha.

---

## 4. Ordem de execução (checklist)

### CRM (vocês no EduIT)

- [ ] A1 scopes + corrigir 401 conversa/canais/users  
- [ ] A2 PUT custom-fields persistente (teste #25)  
- [ ] A3 lostReason obrigatório + enum  
- [ ] A4 filtros `phone` / `updatedSince`  
- [ ] A5 window_closed + templates + mídia  
- [ ] A6 webhooks HMAC  
- [ ] A7 actions form/consultor + webhook form_submitted  
- [ ] A8 DELETE contato, OpenAPI, polo/curso  

### Agente (depois do aceite A)

- [ ] Cliente + adapter + env  
- [ ] Webhook inbound → buffer  
- [ ] Mover etapa + nota + campos  
- [ ] Envio WhatsApp só pelo EduIT  
- [ ] Substituir salesbot  
- [ ] Homologar no #25: pergunta → resposta real (não fallback) → campo curso gravado → move Atendimento  

### Homologação mínima no William #25

1. `GET /api/deals/25`  
2. Gravar `curso` + `polo`  
3. Mover Atendimento e voltar Lead de Entrada  
4. Nota interna  
5. Simular inbound via webhook (ou mandar WhatsApp real) e ver o agente responder  
6. Template com janela fechada (não free text)  

---

## 5. Fora do CRM (continua no agente / Supabase)

Não precisa ir para o EduIT no dia 1:

- `dados_cliente.inscricao_form_status`, captação, pause IA  
- RAG / GPT / LGPD  
- Grade curricular PDF (o CRM só **entrega** o arquivo no WhatsApp)  
- Fila EasyPanel / scheduler  

O CRM precisa ser a **fonte do funil + WhatsApp + ficha**. O cérebro da inscrição pode continuar no Supabase.

---

## 6. Decisão de produto já tomada neste mapeamento

- Dual-write curto, depois EduIT-only.  
- IA só Atendimento + Inscrição (slugs).  
- Sender WhatsApp = EduIT (não misturar Cloud API + CRM).  
- Form/salesbot vira action HTTP + webhook de submit.  
