import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { startScheduler, getStatus } from './server/feedbackJobRunner.js'
import { runNearestPolo } from './server/locationTool.js'
import { runInscricao } from './server/inscricaoTool.js'
import { runDistribuirHumano } from './server/distribuirHumanoTool.js'
import { runBuscarHistorico } from './server/memoryTool.js'
import { marcarClienteIA, updateDadosCliente, getLeadIdByTelefone } from './server/dadosClienteStore.js'
import { saveConversation } from './server/historyStore.js'
import { withSessionLock } from './server/evolution/concurrency.js'
import { findLeadByPhone, createLeadNote } from './server/kommoClient.js'
import { sendMessageWithNote, sendText, splitMessage } from './server/whatsappSender.js'
import { generateExecutionId, saveExecution } from './server/ai/executionTelemetry.js'
import { sendTyping } from './server/evolution/typingIndicator.js'
import { makeEvolutionWebhookHandler } from './server/evolution/webhookEvolution.js'
import { recordWebhookIngress, getWebhookDiagnosticsSnapshot } from './server/evolution/webhookDiagnostics.js'
import { getKommoPollSnapshot } from './server/kommoInboundDiagnostics.js'
import { getModelRegistrySnapshot } from './server/ai/modelRegistry.js'
import { listLeadNotes, listLeadEvents, listLeadCustomFields } from './server/kommoClient.js'
import { getMessagesByLead as dispatcherGetMessagesByLead } from './server/kommoDispatcherClient.js'
import { pingBackend, pushMessage, getMessages, clearMessages } from './server/evolution/messageBuffer.js'
import { getDebounceMs } from './server/evolution/debouncer.js'
import { runAgent } from './server/ai/agentRunner.js'
import { startAgentScheduler, runSchedulerTick, isSchedulerRunning } from './server/agentScheduler.js'
import { runSalesbotCsv, extractLeadIdFromWebhookBody } from './server/salesbot/csvSearch.js'
import { saveSalesbotExecution } from './server/salesbot/telemetry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 8000

app.use(express.json({ limit: '5mb' }))
// O webhook do amocrm/Kommo manda como application/x-www-form-urlencoded
// com chaves em bracket notation (`leads[add][0][id]`). Precisamos de
// `extended: true` pra Express desserializar isso em objeto aninhado.
app.use(express.urlencoded({ extended: true, limit: '2mb' }))

// ── Supabase proxy (principal - dados da IA) ──

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY

// ── Supabase proxy (feedback comercial) ──

const SUPABASE_URL_FEEDBACK = process.env.SUPABASE_URL_FEEDBACK || process.env.VITE_SUPABASE_URL_FEEDBACK
const SUPABASE_KEY_FEEDBACK = process.env.SUPABASE_KEY_FEEDBACK || process.env.VITE_SUPABASE_KEY_FEEDBACK

function makeSupabaseProxy(url, key, label) {
  return async (req, res) => {
    if (!url || !key) {
      return res.status(500).json({ error: `${label} não configurado` })
    }
    try {
      const prefix = req.baseUrl ? req.baseUrl + '/' : ''
      const fullPath = req.originalUrl.replace(prefix, '')
      const targetUrl = `${url}/${fullPath}`
      const headers = {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
      }
      const prefer = req.headers['prefer']
      if (prefer) headers['Prefer'] = prefer

      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : JSON.stringify(req.body),
      })
      const body = await response.text()
      res.status(response.status).set('Content-Type', 'application/json').send(body)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  }
}

app.all('/api/supabase/*path', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL ou SUPABASE_KEY não configurados' })
  }
  try {
    const fullPath = req.originalUrl.replace('/api/supabase/', '')
    const targetUrl = `${SUPABASE_URL}/${fullPath}`

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
    const prefer = req.headers['prefer']
    if (prefer) headers['Prefer'] = prefer

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : JSON.stringify(req.body),
    })
    const body = await response.text()
    res.status(response.status).set('Content-Type', 'application/json').send(body)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.all('/api/feedback-supabase/*path', async (req, res) => {
  if (!SUPABASE_URL_FEEDBACK || !SUPABASE_KEY_FEEDBACK) {
    return res.status(500).json({ error: 'SUPABASE_URL_FEEDBACK ou SUPABASE_KEY_FEEDBACK não configurados' })
  }
  try {
    const fullPath = req.originalUrl.replace('/api/feedback-supabase/', '')
    const targetUrl = `${SUPABASE_URL_FEEDBACK}/${fullPath}`

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY_FEEDBACK,
      'Authorization': `Bearer ${SUPABASE_KEY_FEEDBACK}`,
    }
    const prefer = req.headers['prefer']
    if (prefer) headers['Prefer'] = prefer

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : JSON.stringify(req.body),
    })
    const body = await response.text()
    res.status(response.status).set('Content-Type', 'application/json').send(body)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Feedback Job: scheduler + endpoint de status ──

startScheduler(process.env)

app.get('/api/feedback-job/status', async (_req, res) => {
  try {
    const status = await getStatus(process.env)
    res.json(status)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Tool localização (geocode + polo_loc + Distance Matrix) ──

app.post('/api/location/nearest-polo', async (req, res) => {
  try {
    const out = await runNearestPolo(process.env, req.body || {})
    if (!out.ok) {
      res.status(400).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Tool inscrição (Kommo + Supabase + OpenAI) ──

app.post('/api/inscricao/run', async (req, res) => {
  try {
    const out = await runInscricao(process.env, req.body || {})
    if (!out.ok && (out.code === 'MISSING_CRM_FIELDS' || out.code === 'MISSING_PARAMS')) {
      res.status(400).json(out)
      return
    }
    if (!out.ok) {
      res.status(500).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Tool distribuir_humano (Kommo + 2× Supabase + OpenAI) ──

app.post('/api/distribuir-humano/run', async (req, res) => {
  try {
    const out = await runDistribuirHumano(process.env, req.body || {})
    if (!out.ok && (out.code === 'MISSING_CRM_FIELDS' || out.code === 'LEAD_NOT_ELIGIBLE')) {
      res.status(400).json(out)
      return
    }
    if (!out.ok) {
      res.status(500).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Tool memória (n8n_chat_histories no Supabase principal) ──

app.post('/api/memory/history', async (req, res) => {
  try {
    const out = await runBuscarHistorico(process.env, req.body || {})
    if (!out.ok && (out.code === 'MISSING_PARAMS' || out.code === 'SUPABASE_NOT_CONFIGURED')) {
      res.status(400).json(out)
      return
    }
    if (!out.ok) {
      res.status(500).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Store: dados_cliente (Supabase principal) ──
//    Node "Atualizar Cliente" do N8N: seta teste_AB='IA' + id_lead por telefone.

app.post('/api/clientes/marcar-ia', async (req, res) => {
  try {
    const { telefone, id_lead, idLead } = req.body || {}
    const out = await marcarClienteIA(process.env, {
      telefone,
      idLead: id_lead ?? idLead,
    })
    if (!out.ok) {
      const http = ['MISSING_TELEFONE', 'MISSING_ID_LEAD', 'MISSING_FIELDS', 'SUPABASE_NOT_CONFIGURED'].includes(out.code) ? 400 : 500
      res.status(http).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// UPDATE genérico na mesma tabela — útil para os próximos nodes do fluxo.
app.post('/api/clientes/update', async (req, res) => {
  try {
    const { telefone, fields } = req.body || {}
    const out = await updateDadosCliente(process.env, { telefone, fields })
    if (!out.ok) {
      const http = ['MISSING_TELEFONE', 'MISSING_FIELDS', 'SUPABASE_NOT_CONFIGURED'].includes(out.code) ? 400 : 500
      res.status(http).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Histórico da conversa (chats + chat_messages + face-insta) ──

app.post('/api/history/save', async (req, res) => {
  try {
    const { telefone, user_message, userMessage, bot_message, botMessage, message_type, messageType, id_lead, idLead } = req.body || {}
    const out = await saveConversation(process.env, {
      telefone,
      userMessage: userMessage ?? user_message,
      botMessage: botMessage ?? bot_message,
      messageType: messageType ?? message_type,
      idLead: idLead ?? id_lead,
    })
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Kommo: busca lead por telefone + nota avulsa ──

app.get('/api/kommo/lead-by-phone', async (req, res) => {
  try {
    const telefone = req.query?.telefone || req.query?.phone
    if (!telefone) {
      res.status(400).json({ ok: false, error: 'telefone é obrigatório' })
      return
    }
    const out = await findLeadByPhone(process.env, telefone)
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/kommo/lead-note', async (req, res) => {
  try {
    const { leadId, id_lead, text } = req.body || {}
    const id = leadId ?? id_lead
    if (!id || !text) {
      res.status(400).json({ ok: false, error: 'leadId e text são obrigatórios' })
      return
    }
    const out = await createLeadNote(process.env, id, text)
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── WhatsApp Cloud API (Meta/WACA): envio + nota no Kommo ──
//    Espelha o fluxo do `envio mensagem.txt` do N8N.

app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { telefone, phone, text, message, leadId, id_lead, executionId } = req.body || {}
    const to = telefone ?? phone
    const body = text ?? message
    if (!to || !body) {
      res.status(400).json({ ok: false, error: 'telefone e text são obrigatórios' })
      return
    }
    const out = await sendMessageWithNote(process.env, {
      telefone: to,
      text: body,
      leadId: leadId ?? id_lead,
      executionId,
    })
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Só envio (sem nota), útil pra testar credenciais da Cloud API rapidinho.
app.post('/api/whatsapp/send-text', async (req, res) => {
  try {
    const { telefone, phone, text, message } = req.body || {}
    const to = telefone ?? phone
    const body = text ?? message
    if (!to || !body) {
      res.status(400).json({ ok: false, error: 'telefone e text são obrigatórios' })
      return
    }
    const out = await sendText(process.env, { to, text: body })
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Preview do smartSplit — não chama a API, só mostra como uma mensagem seria dividida.
app.post('/api/whatsapp/split-preview', (req, res) => {
  try {
    const { text, message, maxChars } = req.body || {}
    const body = text ?? message
    if (!body) {
      res.status(400).json({ ok: false, error: 'text é obrigatório' })
      return
    }
    const n = Number(maxChars || process.env.WHATSAPP_MAX_CHARS || 1000)
    const parts = splitMessage(body, n)
    res.json({ ok: true, total: parts.length, maxChars: n, parts })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Evolution: typing/presence indicator ──

app.post('/api/evolution/typing', async (req, res) => {
  try {
    const { jid, telefone, presence, delayMs } = req.body || {}
    const target = jid || telefone
    if (!target) {
      res.status(400).json({ ok: false, error: 'jid (ou telefone) é obrigatório' })
      return
    }
    const out = await sendTyping(process.env, { jid: target, presence, delayMs })
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Webhook Evolution (classifica, transcreve, analisa, debounce, chama IA) ──

function evolutionWebhookIngress(req, res, next) {
  const b = req.body
  const n = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b).length : 0
  recordWebhookIngress({ bodyKeyCount: n, contentType: req.headers['content-type'] || '' })
  console.log(`[Evolution][ingress] POST bodyKeys=${n} content-type=${req.headers['content-type'] || ''}`)
  next()
}

app.post('/api/evolution/webhook', evolutionWebhookIngress, makeEvolutionWebhookHandler(process.env))

app.get('/api/evolution/health', async (_req, res) => {
  try {
    const ping = await pingBackend(process.env)
    res.json({
      ok: true,
      buffer: ping,
      webhookDiagnostics: getWebhookDiagnosticsSnapshot(),
      kommoPoll: getKommoPollSnapshot(),
      kommoDispatcher: {
        url: process.env.KOMMO_DISPATCHER_URL || 'http://banco-kommo-dispatcher:8000',
        configured: Boolean(process.env.KOMMO_DISPATCHER_URL),
        probeEndpoint: '/api/kommo-dispatcher/probe?path=/api/kommo/dashboard/stats',
      },
      models: getModelRegistrySnapshot(process.env),
      queryRewriteEnabled:
        String(process.env.AI_QUERY_REWRITE_ENABLED ?? 'true').toLowerCase() !== 'false',
      debounceMs: getDebounceMs(process.env),
      scheduler: {
        running: isSchedulerRunning(),
        intervalSec: Number(process.env.KOMMO_SCHEDULER_INTERVAL_SEC) || 30,
        debounceSec: Number(process.env.KOMMO_SCHEDULER_DEBOUNCE_SEC) || 15,
        pipelineId: process.env.KOMMO_AGENT_PIPELINE_ID || null,
        statusId: process.env.KOMMO_AGENT_STATUS_ID || null,
      },
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Inspeção do poll Kommo: lista notas brutas (note_type, params.text) para um lead.
app.get('/api/kommo/poll/notes', async (req, res) => {
  try {
    const leadId = Number(req.query.leadId)
    if (!Number.isFinite(leadId) || leadId <= 0) {
      res.status(400).json({ ok: false, error: 'leadId é obrigatório (?leadId=...)' })
      return
    }
    const limit = Math.min(80, Math.max(1, Number(req.query.limit) || 30))
    const out = await listLeadNotes(process.env, leadId, { limit, order: 'desc' })
    if (!out.ok) {
      res.status(500).json({ ok: false, error: out.error || out.status })
      return
    }
    const slim = (out.notes || []).map((n) => ({
      id: n.id,
      created_at: n.created_at,
      updated_at: n.updated_at,
      note_type: n.note_type,
      params: n.params,
    }))
    res.json({ ok: true, leadId, total: slim.length, notes: slim })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Resumo do OpenAPI do banco-kommo-dispatcher ──
//
// Lista todas as rotas + métodos + summary do FastAPI do dispatcher num formato
// legível. Use isto antes de probe — descobre o nome correto da rota de mensagens.
//
//   GET /api/kommo-dispatcher/openapi-summary
//   GET /api/kommo-dispatcher/openapi-summary?filter=msg
app.get('/api/kommo-dispatcher/openapi-summary', async (req, res) => {
  const upstream = String(
    process.env.KOMMO_DISPATCHER_URL || 'http://banco-kommo-dispatcher:8000',
  ).replace(/\/$/, '')
  const filter = String(req.query.filter || '').trim().toLowerCase()
  const url = `${upstream}/openapi.json`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) {
      res.status(502).json({
        ok: false,
        upstream,
        url,
        httpStatus: r.status,
        error: 'openapi.json não retornou 200',
      })
      return
    }
    const spec = await r.json()
    const info = spec?.info || {}
    const paths = spec?.paths || {}
    const routes = []
    for (const [p, methods] of Object.entries(paths)) {
      if (!methods || typeof methods !== 'object') continue
      for (const [method, def] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) continue
        const m = String(method).toUpperCase()
        const summary = def?.summary || def?.operationId || ''
        const params = Array.isArray(def?.parameters)
          ? def.parameters
              .map((x) => `${x?.name}${x?.required ? '*' : ''}:${x?.in || '?'}`)
              .join(',')
          : ''
        routes.push({ method: m, path: p, summary, params })
      }
    }
    routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    const filtered = filter
      ? routes.filter(
          (r) =>
            r.path.toLowerCase().includes(filter) ||
            (r.summary || '').toLowerCase().includes(filter),
        )
      : routes
    res.json({
      ok: true,
      upstream,
      title: info.title || null,
      version: info.version || null,
      filterApplied: filter || null,
      totalRoutes: routes.length,
      shown: filtered.length,
      routes: filtered,
    })
  } catch (e) {
    res.status(502).json({
      ok: false,
      upstream,
      url,
      error: e.message,
      cause: e?.cause?.code || e?.code || null,
    })
  } finally {
    clearTimeout(timer)
  }
})

// ── Proxy de sondagem para o banco-kommo-dispatcher (rede interna do EasyPanel) ──
//
// Usado para descobrir QUAIS endpoints o dispatcher expõe além do
// /api/kommo/dashboard/stats que já conhecemos.
//
//   GET /api/kommo-dispatcher/probe?path=/api/kommo/dashboard/stats
//   GET /api/kommo-dispatcher/probe?path=/api/kommo/messages/by-lead/19884275&limit=10&order=desc
//   GET /api/kommo-dispatcher/probe?path=/api/kommo/messages/sync/19884275&method=POST
//
// Toda query param diferente de `path` e `method` é encaminhada para a rota
// upstream. `method` (default GET) permite testar POST/PUT/DELETE.
//
// Defaults: KOMMO_DISPATCHER_URL=http://banco-kommo-dispatcher:8000
app.get('/api/kommo-dispatcher/probe', async (req, res) => {
  const upstream = String(
    process.env.KOMMO_DISPATCHER_URL || 'http://banco-kommo-dispatcher:8000',
  ).replace(/\/$/, '')
  const rawPath = String(req.query.path || '').trim()
  if (!rawPath || !rawPath.startsWith('/')) {
    res.status(400).json({
      ok: false,
      error: 'path obrigatório (?path=/api/kommo/dashboard/stats)',
      upstream,
    })
    return
  }
  // Encaminha automaticamente todas as outras query params para a rota upstream.
  // Ex.: /probe?path=/api/kommo/messages/by-lead/123&limit=10&order=desc  →
  //       http://dispatcher/api/kommo/messages/by-lead/123?limit=10&order=desc
  const extraEntries = Object.entries(req.query).filter(([k]) => k !== 'path' && k !== 'method')
  let pathWithQuery = rawPath
  if (extraEntries.length > 0) {
    const sep = rawPath.includes('?') ? '&' : '?'
    const qs = extraEntries
      .flatMap(([k, v]) =>
        Array.isArray(v)
          ? v.map((vv) => `${encodeURIComponent(k)}=${encodeURIComponent(String(vv))}`)
          : [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`],
      )
      .join('&')
    pathWithQuery = `${rawPath}${sep}${qs}`
  }
  const method = String(req.query.method || 'GET').toUpperCase()
  const url = `${upstream}${pathWithQuery}`
  const startMs = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(url, { method, signal: ctrl.signal })
    const elapsedMs = Date.now() - startMs
    const ct = r.headers.get('content-type') || ''
    const raw = await r.text()
    let parsed = null
    if (ct.includes('json')) {
      try { parsed = JSON.parse(raw) } catch { parsed = null }
    }
    const summary = parsed && typeof parsed === 'object'
      ? Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => {
            if (Array.isArray(v)) return [k, `array[${v.length}]`]
            if (v && typeof v === 'object') return [k, `object{${Object.keys(v).slice(0, 8).join(',')}}`]
            return [k, typeof v]
          }),
        )
      : null
    res.json({
      ok: r.ok,
      httpStatus: r.status,
      elapsedMs,
      upstream,
      url,
      contentType: ct,
      shape: summary,
      json: parsed,
      textPreview: parsed ? null : raw.slice(0, 1500),
    })
  } catch (e) {
    const cause = e?.cause?.code || e?.code || ''
    let hint
    if (cause === 'ENOTFOUND') {
      hint = `DNS falhou para ${upstream}. Confirme o nome do servico no EasyPanel ou seta KOMMO_DISPATCHER_URL com a URL correta.`
    } else if (cause === 'ECONNREFUSED') {
      hint = `${upstream} recusou conexao — servico desligado ou em outra porta.`
    } else if (e.name === 'AbortError') {
      hint = `Timeout de 15s atingido em ${url}.`
    }
    res.status(502).json({
      ok: false,
      upstream,
      url,
      error: e.message,
      cause,
      hint,
    })
  } finally {
    clearTimeout(timer)
  }
})

// Inspeção do poll Kommo (events): lista eventos brutos do log para um lead/contato.
// Útil para descobrir se a integração de WhatsApp emite eventos de chat no log v4.
//
//   GET /api/kommo/poll/events?leadId=19884275&hours=72                (default: incoming+outgoing chat)
//   GET /api/kommo/poll/events?leadId=19884275&hours=72&types=*        (* = sem filtro de tipo, lista TUDO)
//   GET /api/kommo/poll/events?leadId=19884275&hours=72&types=incoming_chat_message,incoming_message,chat_message_added
//   GET /api/kommo/poll/events?entity=contact&entityId=12345&hours=72  (eventos no contato em vez do lead)
app.get('/api/kommo/poll/events', async (req, res) => {
  try {
    const entity = String(req.query.entity || 'lead').toLowerCase() === 'contact' ? 'contact' : 'lead'
    const entityId = Number(req.query.entityId || req.query.leadId)
    if (!Number.isFinite(entityId) || entityId <= 0) {
      res.status(400).json({ ok: false, error: 'leadId/entityId é obrigatório (?leadId=... ou ?entity=contact&entityId=...)' })
      return
    }
    const limit = Math.min(250, Math.max(1, Number(req.query.limit) || 50))
    const hours = Math.max(0, Number(req.query.hours) || 0)
    const fromTs = hours > 0 ? Math.floor(Date.now() / 1000) - hours * 3600 : 0
    const typesParam = String(req.query.types || '').trim()
    let types
    if (typesParam === '*' || typesParam.toLowerCase() === 'any' || typesParam.toLowerCase() === 'all') {
      types = [] // sem filtro — lista todos os tipos para o entity
    } else if (typesParam) {
      types = typesParam.split(/[,\s]+/).filter(Boolean)
    } else {
      types = ['incoming_chat_message', 'outgoing_chat_message']
    }

    const out = await listLeadEvents(process.env, entityId, {
      types,
      fromTs,
      limit,
      entity,
      entityId,
    })
    if (!out.ok) {
      res.status(500).json({
        ok: false,
        error: out.error || out.status,
        status: out.status || null,
        requestUrl: out.requestUrl || null,
      })
      return
    }
    const slim = (out.events || []).map((e) => ({
      id: e.id,
      type: e.type,
      entity_id: e.entity_id,
      entity_type: e.entity_type,
      created_at: e.created_at,
      created_by: e.created_by,
      value_after: e.value_after ?? null,
    }))
    const counts = slim.reduce((acc, e) => {
      const t = String(e.type || 'unknown').toLowerCase()
      acc[t] = (acc[t] || 0) + 1
      return acc
    }, {})
    res.json({
      ok: true,
      entity,
      entityId,
      filter: { types, fromTs, hours },
      total: slim.length,
      typeCounts: counts,
      requestUrl: out.requestUrl || null,
      events: slim,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ─────────────── Salesbot — Pesquisa de Curso ───────────────
//
// Webhook do Kommo (amocrm) → roda o fluxo "robocsv" que busca o
// curso na base, normaliza e atualiza o lead.
//
// Aceita o path em duas variantes pra facilitar configuração:
//   - POST /api/salesbot/webhook  (preferido, usa header convencional)
//   - POST /webhook/robocsv       (compat com a URL antiga do n8n —
//                                  útil se o operador não quiser mexer
//                                  na config do amocrm)
//
// Resposta sempre 200 (mesmo em erro), pra que o amocrm não tente
// reentregar e gerar duplicação. Os erros ficam visíveis em
// /Execuções Salesbot.
async function handleSalesbotWebhook(req, res) {
  const leadId = extractLeadIdFromWebhookBody(req.body)
  if (!leadId) {
    res.status(200).json({
      ok: false,
      error: 'leadId ausente no payload (esperado leads[add][0][id] ou leads[update][0][id])',
      receivedKeys: Object.keys(req.body || {}).slice(0, 12),
    })
    return
  }
  // Roda assíncrono — mas devolvemos imediato pro amocrm não esperar.
  ;(async () => {
    const exec = await runSalesbotCsv(process.env, { leadId })
    const save = await saveSalesbotExecution(process.env, exec)
    if (!save.ok) {
      console.warn(`[salesbot] saveSalesbotExecution falhou: ${save.error || save.status}`)
    }
    if (exec.error) {
      console.warn(`[salesbot] ${exec.executionId} lead=${leadId} ERRO: ${exec.error}`)
    } else {
      console.log(
        `[salesbot] ${exec.executionId} lead=${leadId} ${exec.encontrado ? 'OK' : 'NAO_ENCONTRADO'} curso="${exec.cursoCorrigido || exec.cursoOriginal}" (${exec.durationMs}ms)`,
      )
    }
  })().catch((e) => {
    console.error('[salesbot] exception não tratada:', e.message)
  })

  res.status(200).json({ ok: true, accepted: true, leadId })
}

app.post('/api/salesbot/webhook', handleSalesbotWebhook)
// Compat com URL antiga do n8n (POST /webhook/robocsv).
app.post('/webhook/robocsv', handleSalesbotWebhook)

// Endpoint manual pra forçar uma execução do salesbot pra testar
// um lead específico, sem precisar disparar via amocrm:
//   POST /api/salesbot/run  body: { leadId: 12345 }
// Resposta vem síncrona com o resultado completo.
app.post('/api/salesbot/run', async (req, res) => {
  try {
    const leadId = Number(req.body?.leadId)
    if (!Number.isFinite(leadId) || leadId <= 0) {
      res.status(400).json({ ok: false, error: 'body.leadId é obrigatório' })
      return
    }
    const exec = await runSalesbotCsv(process.env, { leadId })
    await saveSalesbotExecution(process.env, exec).catch(() => {})
    res.json(exec)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Lista das execuções do salesbot (proxy direto ao Supabase pra
// não precisar replicar lógica no client).
app.get('/api/salesbot/executions', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_KEY não configurado' })
    return
  }
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
    const url = `${SUPABASE_URL}/rest/v1/salesbot_execucoes?select=*&order=created_at.desc&limit=${limit}`
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    const text = await r.text()
    if (!r.ok) {
      res.status(r.status).type('application/json').send(text)
      return
    }
    res.type('application/json').send(text)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Lista TODOS os custom fields de leads no Kommo (id + nome + tipo).
// Útil para descobrir o field_id de campos novos sem precisar abrir
// o painel do Kommo. Resultado vem ordenado por nome.
//   GET /api/kommo/lead-fields           → JSON com todos
//   GET /api/kommo/lead-fields?q=curso   → filtra pelo nome (substring)
//   GET /api/kommo/lead-fields?force=1   → ignora cache (TTL 5min)
app.get('/api/kommo/lead-fields', async (req, res) => {
  try {
    const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true'
    const q = String(req.query.q || '').trim().toLowerCase()
    const out = await listLeadCustomFields(process.env, { force })
    if (!out.ok) {
      res.status(502).json({ ok: false, error: out.error || `status ${out.status}` })
      return
    }
    let fields = (out.raw || []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      enums: Array.isArray(f.enums)
        ? f.enums.map((e) => ({ id: e.id, value: e.value, sort: e.sort }))
        : null,
    }))
    if (q) {
      fields = fields.filter((f) => String(f.name || '').toLowerCase().includes(q))
    }
    fields.sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'))
    res.json({ ok: true, total: fields.length, cached: out.cached, fields })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Inspeção do poll Kommo (dispatcher): lista mensagens cruas que o
// banco-kommo-dispatcher tem cacheadas para um lead. Útil para validar a
// integração antes de ligar mode=dispatcher no scheduler.
//   GET /api/kommo/poll/dispatcher?leadId=19884275&limit=20&order=desc
app.get('/api/kommo/poll/dispatcher', async (req, res) => {
  try {
    const leadId = Number(req.query.leadId)
    if (!Number.isFinite(leadId) || leadId <= 0) {
      res.status(400).json({ ok: false, error: 'leadId é obrigatório (?leadId=...)' })
      return
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
    const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'
    const out = await dispatcherGetMessagesByLead(process.env, leadId, { limit, order })
    if (!out.ok) {
      res.status(502).json({
        ok: false,
        error: out.error || out.status,
        cause: out.cause || null,
        status: out.status || null,
        requestUrl: out.requestUrl || null,
        elapsedMs: out.elapsedMs || null,
        hint:
          'Verifique KOMMO_DISPATCHER_URL e se o servico banco-kommo-dispatcher esta respondendo (use /api/kommo-dispatcher/probe?path=/health).',
      })
      return
    }
    const messages = out.messages || []
    const stats = messages.reduce(
      (acc, m) => {
        const st = String(m?.sender_type || 'unknown').toLowerCase()
        const mt = String(m?.message_type || 'unknown').toLowerCase()
        acc.senderTypes[st] = (acc.senderTypes[st] || 0) + 1
        acc.messageTypes[mt] = (acc.messageTypes[mt] || 0) + 1
        return acc
      },
      { senderTypes: {}, messageTypes: {} },
    )
    const slim = messages.map((m) => ({
      id: m.id,
      sender_type: m.sender_type,
      sender_name: m.sender_name,
      message_type: m.message_type,
      message_text: m.message_text,
      sent_at: m.sent_at,
      origin: m.origin,
      synced_at: m.synced_at,
      chat_id: m.chat_id,
    }))
    res.json({
      ok: true,
      leadId,
      total: messages.length,
      stats,
      requestUrl: out.requestUrl || null,
      elapsedMs: out.elapsedMs || null,
      messages: slim,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Testa o "digitando..." (Evolution presence) num número específico.
// Útil para validar que a instância Evolution está online e aceitando
// presence. Não exige webhook — chama POST /chat/sendPresence direto.
//
//   GET  /api/evolution/typing-test?to=5511945722117&presence=composing&delayMs=8000
//   POST /api/evolution/typing-test   body { to, presence?, delayMs? }
async function handleTypingTest(req, res) {
  try {
    const src = req.method === 'POST' ? { ...(req.body || {}), ...req.query } : req.query
    const to = String(src.to || '').trim()
    if (!to) {
      res.status(400).json({ ok: false, error: 'to é obrigatório (?to=5511XXXXXXXXX ou JID)' })
      return
    }
    const presence = String(src.presence || 'composing').toLowerCase()
    const delayMs = Number(src.delayMs)
    const r = await sendTyping(process.env, {
      jid: to,
      presence,
      delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : undefined,
    })
    if (!r.ok) {
      const hintByCode = {
        EVOLUTION_NOT_CONFIGURED: 'Defina EVOLUTION_API_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE no .env.',
        EVOLUTION_TIMEOUT: 'A Evolution não respondeu em 8s. Verifique se EVOLUTION_API_URL está acessível do container do agente (testa com /api/evolution/typing-test ou ping interno).',
        EVOLUTION_FETCH_FAILED: 'Falha de rede chamando a Evolution. Cheque se EVOLUTION_API_URL está correta (sem barra final, com https://) e se o serviço Evolution está rodando.',
        EVOLUTION_PRESENCE_FAILED: 'A Evolution recebeu mas rejeitou o request. 401=apikey errada, 404=instance errada, 400=number/payload errado.',
      }
      res.status(r.code === 'EVOLUTION_NOT_CONFIGURED' ? 503 : 502).json({
        ok: false,
        code: r.code,
        status: r.status || null,
        error: r.error,
        cause: r.cause || null,
        requestUrl: r.requestUrl || null,
        elapsedMs: r.elapsedMs ?? null,
        hint: hintByCode[r.code] || null,
      })
      return
    }
    res.json({
      ok: true,
      status: r.status,
      data: r.data,
      presence,
      to,
      delayMs: delayMs || null,
      requestUrl: r.requestUrl || null,
      elapsedMs: r.elapsedMs ?? null,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
}
app.get('/api/evolution/typing-test', handleTypingTest)
app.post('/api/evolution/typing-test', handleTypingTest)

// Dispara um tick do scheduler imediatamente (útil para teste).
app.post('/api/scheduler/tick', async (_req, res) => {
  try {
    const stats = await runSchedulerTick(process.env)
    res.json({ ok: true, stats })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Endpoint direto de teste do agente (mesmo loop do webhook, sem buffer) ──

app.post('/api/agent/run', async (req, res) => {
  try {
    const out = await runAgent(process.env, req.body || {})
    if (!out.ok) {
      res.status(500).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Playground: simular o fluxo da Evolution (buffer + debounce) ──
//    push  → empurra a mensagem no buffer (mesma tabela do webhook real)
//    flush → lê tudo, limpa o buffer e dispara o agente; retorna a reply

app.post('/api/playground/push', async (req, res) => {
  try {
    const { sessionId, message } = req.body || {}
    if (!sessionId || !message) {
      res.status(400).json({ ok: false, error: 'sessionId e message são obrigatórios' })
      return
    }
    await pushMessage(process.env, sessionId, message, { skipDedupe: true })
    res.json({ ok: true, sessionId })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/playground/flush', async (req, res) => {
  try {
    const { sessionId, telefone, pushName } = req.body || {}
    if (!sessionId) {
      res.status(400).json({ ok: false, error: 'sessionId é obrigatório' })
      return
    }
    const result = await withSessionLock(sessionId, async () => {
      const itens = await getMessages(process.env, sessionId)
      if (!itens.length) {
        return { ok: true, empty: true, joined: '', reply: null }
      }
      await clearMessages(process.env, sessionId)
      const joined = itens.join(', ')
      const telefoneFinal = telefone || String(sessionId).split('@')[0].replace(/[^0-9]/g, '') || ''
      const executionId = generateExecutionId()
      const startedAt = new Date().toISOString()
      const out = await runAgent(process.env, {
        telefone: telefoneFinal,
        pushName: pushName || '',
        userMessage: joined,
        executionId,
      })
      if (out?.ok && out.reply) {
        getLeadIdByTelefone(process.env, telefoneFinal)
          .then((idLead) =>
            saveConversation(process.env, {
              telefone: telefoneFinal,
              userMessage: joined,
              botMessage: out.reply,
              messageType: 'conversation',
              idLead,
            }),
          )
          .then((hist) => {
            if (hist && !hist.ok) {
              const failed = hist.steps.filter((s) => s.ok === false)
              console.warn(`[${executionId}] playground history falhas:`, JSON.stringify(failed))
            }
          })
          .catch((err) => console.error(`[${executionId}] playground history exception:`, err.message))
      }
      saveExecution(process.env, {
        id: executionId,
        timestamp: startedAt,
        userMessage: joined,
        model: out?.model || null,
        steps: [],
        toolCalls: out?.toolCalls || [],
        response: out?.ok ? out.reply : null,
        error: out?.ok ? null : out?.error || null,
        totalDurationMs: out?.durationMs || 0,
        usage: out?.usage || {},
        aiMeta: out?.aiMeta || null,
        telefone: telefoneFinal,
        origem: 'playground',
      }).catch((err) => console.error(`[${executionId}] playground saveExecution exception:`, err.message))
      return { ok: true, joined, count: itens.length, ...out }
    })
    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Static files ──

app.use(express.static(join(__dirname, 'dist')))
app.get('*path', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  const maps = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY
  console.log(`[Server] Listening on port ${PORT}`)
  console.log(`[Server] Supabase proxy (IA): ${SUPABASE_URL ? 'active' : 'DISABLED'}`)
  console.log(`[Server] Supabase proxy (Feedback): ${SUPABASE_URL_FEEDBACK ? 'active' : 'DISABLED'}`)
  console.log(`[Server] Location tool (Google Maps): ${maps ? 'active' : 'DISABLED'}`)
  const poloTable = process.env.SUPABASE_POLO_TABLE || process.env.POLO_LOC_TABLE || 'polo_loc'
  const poloHost =
    process.env.SUPABASE_POLO_URL ||
    process.env.SUPABASE_URL_FEEDBACK ||
    process.env.VITE_SUPABASE_URL_FEEDBACK ||
    process.env.SUPABASE_URL ||
    ''
  let poloHostLabel = '—'
  try {
    if (poloHost) poloHostLabel = new URL(poloHost).host
  } catch { /* ignore */ }
  console.log(`[Server] Polos: table=${poloTable} host=${poloHostLabel}`)

  const sched = startAgentScheduler(process.env)
  if (!sched.started) {
    console.log(`[Server] Agent scheduler: ${sched.reason}`)
  }
}).on('error', (err) => {
  console.error('[Server] Listen error:', err.message)
})
