# Workflow n8n — Captação Sumaré (testes)

## Importar

1. n8n → **Workflows** → **Import from file**
2. Arquivo: `sumare-captacao-test.workflow.json`

## Variáveis no n8n

Em **Settings → Variables** (ou no node *Dados de teste*):

| Variável | Exemplo |
|----------|---------|
| `SUMARE_CAPTACAO_TOKEN` | token Bearer da API (sem expor no Git) |

## Fluxo do workflow de teste

```
Manual → Dados de teste → 1 Gerar candidato → Extrair candidato_id
  → 2 Status candidato → 3 Aceite contrato → 4 Link + mensagem WhatsApp
```

Saída final (`4 Link + mensagem WhatsApp`):

- `candidato` — ID retornado pela API
- `contractUrl` — `https://sumare.edu.br/vem-pra-sumare/vestibular/contrato?id={candidato}`
- `whatsappMessage` — texto pronto para enviar ao lead

## Testes pelo agente Node (mesmo fluxo)

No `.env` do projeto:

```env
SUMARE_CAPTACAO_ENABLED=true
SUMARE_CAPTACAO_TOKEN=seu_token
SUMARE_CAPTACAO_TEST_ALLOW=true
```

Com `npm start` / `npm run start:local`:

| Ação | Request |
|------|---------|
| Diagnóstico | `GET /api/inscricao/captacao/diagnose` |
| Dry-run (sem API) | `POST /api/inscricao/captacao/test-workflow` body `{ "dryRun": true, "telefone": "5511945010493", "snapshot": { "cpf": "...", "email": "...", "nome": "...", "curso_inscricao": "ECON_EAD", "data_nasc": "2000-09-08", "sexo": "M" } }` |
| Fluxo completo API | `POST /api/inscricao/captacao/test-workflow` body `{ "telefone": "5511...", "leadId": 12345 }` |
| Só passo gerar | `POST /api/inscricao/captacao/test-step/gerar` |
| Só status | `POST /api/inscricao/captacao/test-step/status` body `{ "candidatoId": "2026700000004826" }` |
| Só aceite | `POST /api/inscricao/captacao/test-step/aceite` body `{ "candidatoId": "..." }` |
| Pipeline + WhatsApp | `POST /api/inscricao/captacao/test-pipeline` body `{ "leadId": N, "telefone": "5511...", "sendWhatsapp": false }` |

Use `sendWhatsapp: false` nos testes até validar o link no portal.
