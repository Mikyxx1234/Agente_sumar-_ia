/**
 * Fixtures E2E do fluxo de inscrição.
 *
 * Cobertura mínima exigida pelo plano (Solução definitiva: tools de ação para inscrição):
 *
 *  1. Lead novo confirma matrícula sem polo → exige tool `enviar_form_sumar_inscricao`
 *     (executor retorna POLO_NEEDED + replyOverride com lista de polos)
 *  2. Lead responde polo válido (Tatuapé) → exige tool `registrar_polo_inscricao`
 *  3. Lead responde "3" → executor mapeia para polo 3 (Tatuapé) e dispara form
 *  4. Lead responde polo inválido ("Santo Amaro") → executor retorna INVALID_POLO + lista
 *  5. Lead diz "pronto" → exige tool `confirmar_recebimento_formulario`
 *  6. Regressão (LLM prometeu form sem chamar tool) → guard substitui resposta
 *
 * Como rodamos sem credenciais Supabase/Kommo, focamos nos componentes
 * **puros** (replyGuard) e nos executores com `fetch` stubado. O objetivo é
 * detectar regressões no contrato (forma do retorno + replyOverride canônico)
 * antes do deploy — sem depender de infra externa.
 *
 * Uso:
 *   node scripts/test-inscricao-flow.mjs
 *
 * Sai com código 0 se todos os cenários passam, 1 se algum falha.
 */

import { TOOL_DEFINITIONS, INSCRICAO_ACTION_TOOLS } from '../server/ai/toolDefinitions.js'
import { validateReplyAgainstActions } from '../server/replyGuard.js'
import {
  runEnviarFormSumarInscricao,
  runRegistrarPoloInscricao,
  runConfirmarRecebimentoFormulario,
} from '../server/inscricaoActionTools.js'
import {
  FORM_SUMAR_FLOW_COMPLETED_MARKER,
  messageIsFlowResponsesReceived,
  messageSignalsFormSubmissionAck,
  inboundTextForFormFlowCompletion,
  historyIndicatesFormSumarCompleted,
} from '../libShared/inscricaoFormHeuristics.js'
import { isKommoSystemOrIntegrationNote } from '../libShared/inboundMessageSanitize.js'

let passed = 0
let failed = 0
const failures = []

function ok(name, detail = '') {
  passed += 1
  console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`)
}

function fail(name, msg) {
  failed += 1
  failures.push({ name, msg })
  console.error(`  FAIL  ${name}\n        ${msg}`)
}

function assert(cond, name, detail = '') {
  if (cond) ok(name, detail)
  else fail(name, detail || 'condição falsa')
}

function assertEqual(actual, expected, name) {
  if (actual === expected) ok(name, `=${JSON.stringify(actual)}`)
  else fail(name, `esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)}`)
}

function section(title) {
  console.log(`\n— ${title} —`)
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Stub global de `fetch` para isolar os executores das integrações externas. */
/* ────────────────────────────────────────────────────────────────────────── */

const fetchCalls = []
const realFetch = globalThis.fetch
function installFetchStub(responder) {
  fetchCalls.length = 0
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body || null }
    fetchCalls.push(call)
    const r = responder(call)
    const status = r.status ?? 200
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => (text ? JSON.parse(text) : null),
    }
  }
}
function restoreFetch() {
  globalThis.fetch = realFetch
}

/** Stub Supabase REST padrão: retorna `dadosClienteRow` para SELECT e `representation` no PATCH/POST. */
function defaultSupabaseStub({ dadosClienteRow = null, salesbotOk = true } = {}) {
  return (call) => {
    const u = call.url
    if (u.includes('/rest/v1/dados_cliente_sum') && call.method === 'GET') {
      return { status: 200, body: dadosClienteRow ? [dadosClienteRow] : [] }
    }
    if (u.includes('/rest/v1/dados_cliente_sum') && (call.method === 'PATCH' || call.method === 'POST')) {
      return { status: 200, body: [{ ok: true, ...(dadosClienteRow || {}) }] }
    }
    // Salesbot run — endpoint chave para deliverInscricaoForm
    if (u.includes('/api/v2/salesbot/run')) {
      return salesbotOk
        ? { status: 200, body: [{ entity_type: 'leads', bot_id: 49815, status: 'started' }] }
        : { status: 500, body: { error: 'mock failure' } }
    }
    if (u.includes('/api/v4/leads')) {
      if (u.includes('/notes') || u.includes('/events')) {
        return { status: 200, body: { _embedded: { notes: [], events: [] } } }
      }
      if (/\/api\/v4\/leads\/\d+/.test(u)) {
        return { status: 200, body: { id: 23845769, custom_fields_values: [] } }
      }
      return { status: 200, body: { _embedded: { leads: [{ id: 23845769 }] } } }
    }
    return { status: 200, body: {} }
  }
}

const env = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_KEY: 'mock-key',
  SUPABASE_DADOS_CLIENTE_TABLE: 'dados_cliente_sum',
  KOMMO_BASE_URL: 'https://mock.kommo.com',
  KOMMO_ACCESS_TOKEN: 'mock-token',
  KOMMO_SALESBOT_FORMULARIO_SUM_ID: '49815',
  KOMMO_SALESBOT_MIN_INTERVAL_SEC: '0',
  INSCRICAO_FORM_DELIVERY: 'kommo_salesbot',
  SUMARE_CAPTACAO_ENABLED: 'false',
}

const ctx = {
  telefone: '5511999990000',
  leadId: 23845769,
  pushName: 'Lead Teste',
  executionId: 'EX-TEST-0001',
  model: 'gpt-4.1-mini',
  t0: Date.now(),
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 0 — Estrutura das tools                                          */
/* ────────────────────────────────────────────────────────────────────────── */
section('Tools de ação registradas')

const toolNames = TOOL_DEFINITIONS.map((t) => t.function?.name)
assert(toolNames.includes('enviar_form_sumar_inscricao'), 'tool enviar_form_sumar_inscricao definida')
assert(toolNames.includes('registrar_polo_inscricao'), 'tool registrar_polo_inscricao definida')
assert(toolNames.includes('confirmar_recebimento_formulario'), 'tool confirmar_recebimento_formulario definida')
assertEqual(INSCRICAO_ACTION_TOOLS.size, 3, 'INSCRICAO_ACTION_TOOLS tem 3 tools')

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 1 — Lead novo: quero me inscrever em administração               */
/* ────────────────────────────────────────────────────────────────────────── */
section('1. Lead novo confirma matrícula sem polo')

installFetchStub(defaultSupabaseStub({ dadosClienteRow: { id: 1, id_lead: 23845769 } }))
try {
  const r = await runEnviarFormSumarInscricao(env, { telefone: ctx.telefone, curso: 'Administração' }, ctx)
  assertEqual(r.ok, false, '1.ok=false (precisa de polo)')
  assertEqual(r.code, 'POLO_NEEDED', '1.code=POLO_NEEDED')
  assert(/polo/i.test(r.replyOverride || ''), '1.replyOverride pede polo')
  assert(/1\.\s*\*?S/i.test(r.replyOverride || ''), '1.replyOverride lista polos numerados')
  assertEqual(r.ctxSnapshot?.inscricaoForm, 'aguardando_escolha_polo_pre_form', '1.estado=aguardando_escolha_polo_pre_form')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 2 — Lead responde polo válido (Tatuapé)                          */
/* ────────────────────────────────────────────────────────────────────────── */
section('2. Lead responde polo Tatuapé')

installFetchStub(defaultSupabaseStub({ dadosClienteRow: { id: 1, id_lead: 23845769, inscricao_form_status: 'aguardando_escolha_polo_pre_form' } }))
try {
  const r = await runRegistrarPoloInscricao(env, { telefone: ctx.telefone, polo_id: 'tatuape' }, ctx)
  assertEqual(r.ok, true, '2.ok=true')
  assertEqual(r.code, 'POLO_REGISTRADO_OK', '2.code=POLO_REGISTRADO_OK')
  assert(/Tatuap[eé]/i.test(r.replyOverride || ''), '2.replyOverride confirma polo Tatuapé')
  assert(/formul[aá]rio/i.test(r.replyOverride || ''), '2.replyOverride menciona formulário')
  assertEqual(r.ctxSnapshot?.inscricaoForm, 'aguardando_form_sumar', '2.estado=aguardando_form_sumar')
  assertEqual(r.ctxSnapshot?.poloId, 'tatuape', '2.polo=tatuape')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 3 — Lead responde apenas "3"                                     */
/* ────────────────────────────────────────────────────────────────────────── */
section('3. Lead responde número de polo "3"')

// Lead diferente p/ evitar dedupe do salesbot (cache em memória).
installFetchStub(defaultSupabaseStub({ dadosClienteRow: { id: 2, id_lead: 99887766, inscricao_form_status: 'aguardando_escolha_polo_pre_form' } }))
try {
  // O LLM converte "3" no polo_id correspondente (tatuape) antes de chamar a tool.
  // Aqui validamos que ao receber o polo_id mapeado, o executor grava e dispara.
  const r = await runRegistrarPoloInscricao(
    env,
    { telefone: '5511988880000', polo_id: 'tatuape' },
    { ...ctx, telefone: '5511988880000', leadId: 99887766 },
  )
  assertEqual(r.ok, true, '3.ok=true (polo 3 mapeado para tatuape)')
  assertEqual(r.ctxSnapshot?.poloId, 'tatuape', '3.polo=tatuape')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 4 — Polo inválido (Santo Amaro)                                  */
/* ────────────────────────────────────────────────────────────────────────── */
section('4. Polo inválido (Santo Amaro)')

installFetchStub(defaultSupabaseStub({ dadosClienteRow: { id: 1, id_lead: 23845769 } }))
try {
  const r = await runRegistrarPoloInscricao(env, { telefone: ctx.telefone, polo_id: 'santo_amaro' }, ctx)
  assertEqual(r.ok, false, '4.ok=false')
  assertEqual(r.code, 'INVALID_POLO', '4.code=INVALID_POLO')
  assert(/polo/i.test(r.replyOverride || ''), '4.replyOverride pede polo válido')
  assert(/Tatuap[eé]|Pinheiros|S[aã]o Miguel/i.test(r.replyOverride || ''), '4.replyOverride lista polos válidos')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 5 — Form preenchido ("pronto")                                   */
/* ────────────────────────────────────────────────────────────────────────── */
section('5. Lead diz "pronto" após formulário')

installFetchStub(
  defaultSupabaseStub({
    dadosClienteRow: {
      id: 1,
      id_lead: 23845769,
      inscricao_form_status: 'aguardando_form_sumar',
      polo_inscricao_escolhido: 'Tatuapé',
      captacao_unidade: 'ED_SP_P3',
    },
  }),
)
try {
  const r = await runConfirmarRecebimentoFormulario(env, { telefone: ctx.telefone }, ctx)
  // SUMARE_CAPTACAO_ENABLED=false → cai no fallback (salesbot 49813 ou reply genérico)
  assert(['INSCRICAO_REGISTRADA_OK', 'CAPTACAO_FAILED'].includes(r.code), `5.code esperado em [INSCRICAO_REGISTRADA_OK, CAPTACAO_FAILED] (atual=${r.code})`)
  assert(typeof r.replyOverride === 'string' && r.replyOverride.length > 0, '5.replyOverride não vazio')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 6 — Regressão: LLM promete formulário sem tool                   */
/* ────────────────────────────────────────────────────────────────────────── */
section('6. Reply guard: LLM promete formulário sem chamar tool')

{
  // Promessa de envio futuro
  const v1 = validateReplyAgainstActions({
    reply: 'Perfeito! Vou enviar o formulário de inscrição em instantes, pode aguardar.',
    toolCalls: [],
    stage: null,
  })
  assertEqual(v1.violation, true, '6.1 promessa "vou enviar formulário" detectada')
  assertEqual(v1.code, 'promise_form_send_without_tool', '6.1 code=promise_form_send_without_tool')
  assert(/polo/i.test(v1.safeReply || ''), '6.1 safeReply pede polo')

  // Afirmação de envio passado
  const v2 = validateReplyAgainstActions({
    reply: 'Pronto! Acabei de enviar o formulário aqui no WhatsApp.',
    toolCalls: [],
    stage: 'aguardando_escolha_polo_pre_form',
  })
  assertEqual(v2.violation, true, '6.2 afirmação "acabei de enviar formulário" detectada')
  assert(/polo/i.test(v2.safeReply || ''), '6.2 safeReply pede polo (estado=aguardando_polo)')

  // Reply consistente (tool foi chamada) → não viola
  const v3 = validateReplyAgainstActions({
    reply: 'Polo Tatuapé registrado. Acabei de enviar o formulário no WhatsApp.',
    toolCalls: [{ tool: 'registrar_polo_inscricao', ok: true, actionOk: true }],
    stage: 'aguardando_form_sumar',
  })
  assertEqual(v3.violation, false, '6.3 reply com tool=registrar_polo_inscricao não dispara guard')

  // Reply afirma inscrição concluída sem tool de captação
  const v4 = validateReplyAgainstActions({
    reply: 'Sua inscrição foi registrada com sucesso na Sumaré!',
    toolCalls: [],
    stage: 'aguardando_form_sumar',
  })
  assertEqual(v4.violation, true, '6.4 afirmação "inscrição registrada" detectada')
  assertEqual(v4.code, 'inscricao_done_without_tool', '6.4 code=inscricao_done_without_tool')

  // Texto neutro (nada afirmado) → não viola
  const v5 = validateReplyAgainstActions({
    reply: 'Posso te dar mais informações sobre o curso de Administração?',
    toolCalls: [],
    stage: null,
  })
  assertEqual(v5.violation, false, '6.5 texto neutro não dispara guard')
}

section('7. Flow responses received (WhatsApp Flow / Kommo)')

{
  assert(messageIsFlowResponsesReceived('Flow responses received'), '7.1 detecta texto exato EN')
  assert(
    messageIsFlowResponsesReceived('Preencha o form.\nFlow responses received'),
    '7.1b detecta flow embutido na nota',
  )
  assertEqual(
    inboundTextForFormFlowCompletion('Flow responses received'),
    FORM_SUMAR_FLOW_COMPLETED_MARKER,
    '7.2 normaliza para marcador interno',
  )
  assert(
    !isKommoSystemOrIntegrationNote('Flow responses received'),
    '7.3 não classifica flow como nota de sistema',
  )
  assert(
    messageSignalsFormSubmissionAck(FORM_SUMAR_FLOW_COMPLETED_MARKER),
    '7.4 marcador dispara ack de formulário',
  )
  assert(
    historyIndicatesFormSumarCompleted([
      { role: 'user', content: FORM_SUMAR_FLOW_COMPLETED_MARKER },
      { role: 'user', content: 'pronto' },
    ]),
    '7.5 histórico com flow + pronto indica form concluído',
  )
  assert(
    !historyIndicatesFormSumarCompleted([{ role: 'user', content: 'oi' }]),
    '7.6 saudação isolada não indica form',
  )
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Resumo                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

console.log(`\nResumo: ${passed} passaram, ${failed} falharam.`)
if (failed > 0) {
  for (const f of failures) console.error(`  • ${f.name}: ${f.msg}`)
  process.exit(1)
}
process.exit(0)
