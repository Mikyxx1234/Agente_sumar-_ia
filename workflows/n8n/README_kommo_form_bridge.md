# Ponte Kommo → n8n → Agente (formulário preenchido)

Contingência quando o **WhatsApp Trigger** do n8n (`log_inscricao_feita_sum`) **não recebe** o `nfm_reply` da Meta.

## Arquivo

- `log_inscricao_feita_sum_kommo_bridge.json` — importar no n8n e **ativar**.
- `SALESBOT_KOMMO_MANUAL.md` — passo a passo Salesbot na UI (se não usar o agente).

## Recomendado: Opção A (agente dispara — sem Salesbot)

O agente detecta `"Respostas recebidas no Flow"` no poll Kommo e chama o n8n automaticamente (`server/kommoN8nFormBridge.js`).

No **EasyPanel** (agente_sumare):

```env
KOMMO_INBOUND_POLL_ENABLED=true
N8N_KOMMO_FORM_BRIDGE_URL=https://n8n-new-n8n.ca31ey.easypanel.host/webhook/kommo-form-sum-completed
N8N_KOMMO_FORM_BRIDGE_ENABLED=true
```

Instância n8n Sumaré: `https://n8n-new-n8n.ca31ey.easypanel.host`  
Editor do workflow (só UI, **não** usar como webhook): `/workflow/p5X5pk2QLLgDepm9`

Redeploy → preencher form → log `[kommo-n8n-bridge] lead=... ok=true`.

## Opção B: Salesbot no Kommo (manual)

Ver **`SALESBOT_KOMMO_MANUAL.md`**. A API Kommo não permite criar Salesbot por código.

## URL do webhook n8n (após importar)

Após ativar o workflow, copie a **Production URL** do nó **Webhook Kommo (form preenchido)**.

Formato típico:

```text
https://<SEU-N8N>/webhook/kommo-form-sum-completed
```

## Payload que o Salesbot deve enviar

```json
{
  "lead_id": "{{lead.id}}",
  "phone": "{{contact.phone}}",
  "message": "{{message.text}}",
  "source": "kommo_salesbot",
  "trigger": "form_flow_completed"
}
```

Campos aceitos (flexível):

| Campo | Alternativas |
|-------|----------------|
| `lead_id` | `leadId`, `id_lead`, `entity_id` |
| `phone` | `telefone`, `wa_id`, `whatsapp` |
| `message` | `text`, `body` |

## Configurar Salesbot no Kommo

1. **Kommo → Automação → Salesbot** (ou bot no funil do agente).
2. **Gatilho:** mensagem recebida no WhatsApp **do candidato** (não mensagens enviadas pelo bot).
3. **Condição (importante):** texto contém `Respostas recebidas no Flow`  
   (ou equivalente em inglês: `Flow responses received`).
4. **Ação:** Enviar requisição HTTP **POST** para a URL do webhook n8n acima.
5. **Corpo:** JSON acima com `lead_id` e telefone do contato.
6. **Não** disparar em mensagens de saída do agente (evita loop).

### Funil / status sugeridos

- Pipeline: `13756724` (Agente-Sumaré)
- Status: `106140284` (Atendimento) ou onde o lead fica durante o form

## O que o workflow faz

1. Recebe POST do Kommo (form concluído).
2. Busca lead + notas no Kommo (tenta achar `response_json` do Flow nas notas).
3. Grava nota com CPF/nome/email (quando disponível).
4. Atualiza campos do card (`1475361` nome, `1475363` cpf, etc.) e move para status **`106804680`**.
5. Notifica o **agente** em `POST /api/evolution/webhook` com marcador `[FORMULARIO_SUMAR_PREENCHIDO]` para disparar o pós-formulário.

## Credenciais a configurar no n8n

1. **Kommo OAuth** — reutilize `Kommo acadêmico/comercial - BU` (mesma do workflow original).
2. **GET lead / GET notas** — substitua `CONFIGURE_KOMMO_HEADER_AUTH` por credencial **Header Auth**:
   - Name: `Authorization`
   - Value: `Bearer <KOMMO_ACCESS_TOKEN>`
3. **Notificar agente** — se `EVOLUTION_WEBHOOK_TOKEN` estiver ativo no EasyPanel, adicione header:
   - `Authorization: Bearer <token>`

## Teste manual (curl)

```bash
curl -X POST "https://<SEU-N8N>/webhook/kommo-form-sum-completed" \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": 23841399,
    "phone": "5511944690752",
    "message": "Respostas recebidas no Flow",
    "source": "kommo_salesbot",
    "trigger": "form_flow_completed"
  }'
```

Esperado: execução no n8n + lead movido + agente recebe marcador de form preenchido.

## Limitação

Se o Kommo **não guardar** o `response_json` do Flow em notas/campos, nome/CPF podem vir vazios — o lead ainda avança de status e o **agente** é notificado. Nesse caso, corrigir a entrega Meta→n8n (`wa_sumare_n8n`) continua sendo a solução definitiva para dados completos.

## Relação com o workflow original

| Workflow | Gatilho | Quando usar |
|----------|---------|-------------|
| `log_inscricao_feita_sum` | WhatsApp Trigger Meta (`nfm_reply`) | Meta entregando webhooks ao n8n |
| `log_inscricao_feita_sum_kommo_bridge` | Webhook HTTP do Salesbot Kommo | Meta **não** entrega ao n8n; Kommo vê "Respostas recebidas no Flow" |

Os dois podem ficar **ativos** — use dedupe por `lead_id` se necessário (evitar rodar duas vezes no mesmo preenchimento).
