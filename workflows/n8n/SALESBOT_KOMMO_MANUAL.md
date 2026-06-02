# Salesbot Kommo — ponte formulário → n8n (manual)

A API pública do Kommo **não permite criar Salesbots por código** (`/api/v2/salesbot` é privada). Use uma das opções:

| Opção | Quem dispara | Recomendado |
|-------|----------------|-------------|
| **A — Agente (automático)** | `kommoInboundPoll` detecta "Respostas recebidas no Flow" e POST no n8n | Sim |
| **B — Salesbot (manual)** | Você cria o bot no Kommo conforme abaixo | Se o poll não estiver ativo |

---

## Opção A — Agente (sem Salesbot)

1. Importe e ative `log_inscricao_feita_sum_kommo_bridge.json` no n8n.
2. No **EasyPanel** (agente_sumare), configure:

```env
KOMMO_INBOUND_POLL_ENABLED=true
KOMMO_INBOUND_POLL_MODE=notes
N8N_KOMMO_FORM_BRIDGE_URL=https://<SEU-N8N>/webhook/kommo-form-sum-completed
N8N_KOMMO_FORM_BRIDGE_ENABLED=true
```

3. Redeploy do agente.
4. Preencha o formulário de teste — o log deve mostrar `[kommo-n8n-bridge] lead=... POST ... ok=true`.

---

## Opção B — Criar Salesbot no Kommo (UI)

### 1. Abrir o construtor

1. Kommo → **Automação** → **Salesbot** → **Criar Salesbot**.
2. Nome sugerido: `Bridge Form Sumar → n8n`.

### 2. Gatilho

- **Quando:** mensagem recebida no chat (WhatsApp).
- **Pipeline:** `13756724` (Agente-Sumaré).
- **Status:** `106140284` (Atendimento) — ou "Qualquer status" nesse funil.

### 3. Condição (importante)

Adicione bloco **Condição**:

- Se **texto da mensagem** **contém** `Respostas recebidas no Flow`  
  (alternativa em inglês: `Flow responses received`).

> Dispare **somente em mensagens de entrada** do candidato, não em mensagens enviadas pelo bot/agente.

### 4. Ação — Requisição HTTP

Bloco **Enviar requisição** / **Webhook** / **Widget request** (conforme sua conta):

| Campo | Valor |
|-------|--------|
| Método | `POST` |
| URL | `https://<SEU-N8N>/webhook/kommo-form-sum-completed` |
| Content-Type | `application/json` |
| Corpo | ver JSON abaixo |

```json
{
  "lead_id": "{{lead.id}}",
  "phone": "{{contact.phone}}",
  "message": "{{message.text}}",
  "source": "kommo_salesbot",
  "trigger": "form_flow_completed"
}
```

Placeholders podem variar (`{{lead.id}}`, `{{contact.phone}}`, `{{message_text}}` — use os disponíveis no editor).

### 5. Resposta esperada

O n8n deve responder **HTTP 200** em até ~2s (Kommo exige ack rápido). O workflow `kommo_bridge` responde via nó **Responder OK**.

### 6. Ativar

Salve e **ative** o Salesbot. Teste com lead #23841399 após preencher o formulário.

### 7. Evitar duplicidade

Se **Opção A (agente)** e **Opção B (Salesbot)** estiverem ativas juntas, o n8n pode rodar 2 vezes. Use **só uma**, ou dedupe no n8n por `lead_id`.

---

## Checklist de teste

- [ ] Workflow n8n `log_inscricao_feita_sum_kommo_bridge` **ativo**
- [ ] URL do webhook copiada para env do agente **ou** Salesbot
- [ ] Credenciais Kommo nos nós HTTP do n8n (Header Auth Bearer)
- [ ] Lead preenche form → execução aparece no n8n **Executions**
- [ ] Campos do card atualizados + status `106804680`
- [ ] Agente recebe `[FORMULARIO_SUMAR_PREENCHIDO]` e segue pós-formulário
