/**
 * Tool inscrição — espelha o subfluxo N8N em tool inscrição.txt
 *
 * Entradas do N8N (Execute Workflow Trigger):
 *   - telefone  → hoje costuma vir de $('Code').item.json.telefoneCorreto (integração pendente no app)
 *   - id_lead   → $('Edit Fields1').item.json.data._embedded.leads[0].id (CRM/Kommo — pendente)
 *   - Curso     → definido pelo modelo (orquestrador)
 *   - Tipo de ingresso → ENEM / Vestibular Múltipla Escolha (modelo)
 *
 * Quando telefone ou id_lead faltam, não chamamos Kommo/Supabase do fluxo completo;
 * retornamos MISSING_CRM_FIELDS para o modelo informar o usuário ou aguardar integração.
 *
 * Env (fluxo completo):
 *   KOMMO_BASE_URL          ex: https://admamoeduitcombr.kommo.com
 *   KOMMO_ACCESS_TOKEN      Bearer (long-lived / OAuth)
 *   KOMMO_SALESBOT_BOT_ID   ex: 46605
 *   KOMMO_PIPELINE_ID       funil (ex: 5481944) — mesmo pipeline para atendimento e aguardando inscrição
 *   KOMMO_STATUS_ID         etapa atendimento / fallback quando faltam nome ou nível (ex: 48539246)
 *   KOMMO_STATUS_AGUARDANDO_INSCRICAO opcional; default 99045180 (Aguardando Inscrição, mesmo funil)
 *   Sem nome+nível válidos no resumo: não dispara salesbot/formulário, não grava inscricao_ab, não pausa IA;
 *     só nota + PATCH em atendimento + distribuicao.
 *   INSCRICAO_TEST_OVERRIDES=true + body._test_nome_candidato + body._test_nivel — só para testar Kommo
 *     (nunca em produção).
 *   SUPABASE_URL + SUPABASE_KEY — projeto "BANCO AGENTE COMERCIAL" (tabelas abaixo)
 *
 * Tabelas Supabase usadas: inscricao_ab, dados_cliente, chat_messages, distribuicao_por_consultor
 */

import { resolveModel } from './ai/modelRegistry.js'
import { findLeadByPhone, listLeadCustomFields } from './kommoClient.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { getDefaultTipoIngresso } from './inscricaoConfig.js'

// IDs dos campos "fixos" do Kommo. Para os campos da seção
// "Inscrição" temos uma cascata: env > ID hardcodado conhecido >
// descoberta dinâmica via listLeadCustomFields(). Assim o operador
// pode sobrescrever via env sem mexer no código, e se ele não fizer
// nada, a tool ainda funciona com os defaults da instância atual.
const KOMMO_FIELD_CURSO = 31782 // "Curso" (campo do funil de vendas)
const KOMMO_FIELD_NIVEL = 31786 // "Formação" / "Nível"
const KOMMO_FIELD_NOME = 304628 // "Nome"

// IDs descobertos pelo painel do Kommo / endpoint debug
// /api/kommo/lead-fields. Esses defaults valem para a instância
// admamoeduitcombr.kommo.com — em outras instâncias, sobrescrever
// via env (KOMMO_FIELD_*_ID).
const KOMMO_FIELD_CURSO_INSCRICAO_DEFAULT = 693835
const KOMMO_FIELD_POLO_INSCRICAO_DEFAULT = 693837
const KOMMO_FIELD_TIPO_INSCRICAO_DEFAULT = 693843

// Aliases por nome — usados como fallback se o ID hardcoded não
// funcionar. Cubrimos variações comuns de PT-BR (com/sem acento,
// com/sem underscore) pra ser tolerante a renomeações no painel.
const FIELD_NAME_ALIASES = {
  cursoInscricao: ['Curso Inscrição', 'Curso da Inscrição', 'Curso_Inscricao', 'Curso da Inscricao'],
  poloInscricao: ['Polo Inscrição', 'Polo da Inscrição', 'Polo_Inscricao', 'Polo da Inscricao'],
  tipoInscricao: ['Tipo Inscrição', 'Tipo de Ingresso', 'Tipo_Inscricao', 'Tipo de Inscrição', 'Tipo da Inscrição', 'Tipo_Inscrição'],
}

// Pega o ID prioritário (env override > default hardcoded), e em
// seguida resolve a definição completa (type + enums) consultando o
// snapshot dos custom fields. Se nada bater, tenta descobrir pelo
// nome via aliases.
function resolveFieldDef(env, envVar, hardcodedId, aliases, fieldsByName, fieldsById) {
  const candidates = []
  const fromEnv = Number(env?.[envVar])
  if (Number.isFinite(fromEnv) && fromEnv > 0) candidates.push(fromEnv)
  if (Number.isFinite(hardcodedId) && hardcodedId > 0) candidates.push(hardcodedId)

  for (const id of candidates) {
    const def = fieldsById?.get?.(id)
    if (def) return def
    // Se não temos snapshot dos fields (descoberta falhou), usamos só
    // o ID — sem saber se é text/select. Tratamos como text por padrão.
    if (!fieldsByName) return { id, type: 'text', name: `unknown:${id}`, enums: null, _fromIdOnly: true }
  }

  return resolveFieldByAliases(fieldsByName, aliases)
}

function resolveFieldByAliases(fieldsByName, aliases) {
  if (!fieldsByName) return null
  for (const a of aliases) {
    const def = fieldsByName.get(String(a).trim().toLowerCase())
    if (def) return def
  }
  return null
}

// Para campos do tipo "select" (enum) do Kommo, o PATCH exige
// `enum_id` (não `value`). Tenta achar o enum pelo `value` exato,
// depois case-insensitive, depois substring. Retorna `null` se não
// achar — caller decide se manda `value` puro (campos `text`) ou
// pula o campo.
function pickEnumIdFor(def, value) {
  if (!def?.enums || !value) return null
  const target = String(value).trim()
  const targetLower = target.toLowerCase()
  let m = def.enums.find((e) => String(e.value).trim() === target)
  if (m) return m.id
  m = def.enums.find((e) => String(e.value).trim().toLowerCase() === targetLower)
  if (m) return m.id
  m = def.enums.find((e) => String(e.value).toLowerCase().includes(targetLower))
  if (m) return m.id
  return null
}

function buildCustomFieldEntry(def, value) {
  if (!def) return null
  if (def.type === 'select' || def.type === 'multiselect' || (Array.isArray(def.enums) && def.enums.length > 0)) {
    const enumId = pickEnumIdFor(def, value)
    if (enumId == null) return null
    return { field_id: def.id, values: [{ enum_id: enumId }] }
  }
  return { field_id: def.id, values: [{ value: String(value) }] }
}

/** Etapa Kommo “Aguardando inscrição” (mesmo pipeline_id que o restante do fluxo). */
const DEFAULT_STATUS_AGUARDANDO_INSCRICAO = 99045180

/** Valores vazios / “Não informado” / equivalentes → considerado ausente para regra de fallback. */
function isCampoAusente(val) {
  const t = String(val ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!t) return true
  if (/^n[ãa]o informado\.?$/i.test(t)) return true
  if (/^n\/a$/i.test(t)) return true
  if (t === '-' || t === '—') return true
  return false
}

const SUMMARY_PROMPT_PREFIX = `Prompt para Agente de Resumo de Conversas
Você é um assistente especializado em resumir conversas do WhatsApp entre o assistente virtual comercial da Faculdade Sumaré e candidatos.
Sua Tarefa
Analise a conversa completa abaixo e crie um resumo estruturado:
`

const SUMMARY_PROMPT_SUFFIX = `
Informações para Identificar

Nome do candidato: Procure por qualquer menção ao nome (completo ou primeiro nome)
Nível de interesse: Graduação, Pós-graduação ou Não informado
Curso específico: Nome exato do curso mencionado
Informações fornecidas: Valores, prazos, links, documentos, detalhes de inscrição
Status: Se o candidato ainda está respondendo ou parou de responder

Classificação de Níveis

Graduação: Bacharelado, licenciatura, tecnólogo (ex: Administração, Engenharia, Direito, Psicologia)
Pós-graduação: MBA, especialização, mestrado, doutorado
Não informado: Quando não fica claro o nível de interesse

Formato de Resposta Obrigatório
Resumo: [2-6 frases descrevendo o que aconteceu na conversa, incluindo nome do candidato se mencionado e principais informações fornecidas pelo assistente]
Nome do candidato: [Nome identificado ou "Não informado"]
Nível: [Graduação/Pós-graduação/Não informado]
Curso: [Nome do curso ou "Não informado"]
Informações fornecidas pela IA: [Liste as principais informações, orientações, valores, links ou documentos que a IA compartilhou com o candidato]
Status da conversa: [Candidato respondeu/Candidato parou de responder]
IMPORTANTE: Responda APENAS no formato acima, sem repetir estas instruções.`

function normalizeTelefone(t) {
  if (t == null) return ''
  return String(t).trim()
}

function normalizeIdLead(id) {
  if (id == null || id === '') return null
  const n = Number(id)
  // Trata 0 / negativos como "ausente" (default da OpenAI quando o
  // LLM não tem o ID real). Caller deve fazer fallback por telefone.
  return Number.isFinite(n) && n > 0 ? n : null
}

// "Curso" tem que ter conteúdo de verdade — strings de 2-3 chars
// como "as" / "ola" são quase sempre alucinação do LLM. Aceita só
// se tem ≥4 caracteres alfabéticos (espaços não contam).
function isCursoValido(s) {
  const t = String(s || '').trim()
  if (!t) return false
  const alpha = t.replace(/[^A-Za-zÀ-ÿ]/g, '')
  return alpha.length >= 4
}

function extractField(text, fieldName, fieldNames) {
  const others = fieldNames.filter((f) => f !== fieldName).join('|')
  const regex = new RegExp(
    `${fieldName}:\\s*([\\s\\S]*?)(?=\\n(?:${others}):|$)`,
    'i',
  )
  const match = text.match(regex)
  return match ? match[1].trim().replace(/\s+/g, ' ') : ''
}

function parseResumoCampos(inputText) {
  const fieldNames = [
    'Resumo',
    'Nome do candidato',
    'Nível',
    'Nivel',
    'Curso',
    'Informações fornecidas pela IA',
    'Status da conversa',
    'Status',
  ]
  const resumo = extractField(inputText, 'Resumo', fieldNames) || 'Não informado'
  const nome = extractField(inputText, 'Nome do candidato', fieldNames) || 'Não informado'
  const nivel =
    extractField(inputText, 'Nível', fieldNames) ||
    extractField(inputText, 'Nivel', fieldNames) ||
    'Não informado'
  const curso = extractField(inputText, 'Curso', fieldNames) || 'Não informado'
  const infoIA =
    extractField(inputText, 'Informações fornecidas pela IA', fieldNames) || 'Não informado'
  const status =
    extractField(inputText, 'Status da conversa', fieldNames) ||
    extractField(inputText, 'Status', fieldNames) ||
    'Não informado'
  return {
    resumo,
    nome_candidato: nome,
    nivel,
    curso,
    informacoes_ia: infoIA,
    status_conversa: status,
    texto_original: inputText,
  }
}

function buildConversationFromMessages(rows) {
  const sorted = [...rows].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at),
  )
  return sorted
    .map((row) => {
      const u = row.user_message ? `Usuário: ${row.user_message}` : ''
      const b = row.bot_message ? `Bot: ${row.bot_message}` : ''
      return [u, b].filter(Boolean).join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Resume a conversa via OpenAI. Retorna { content, model, usage } para
 * que o caller acumule custo no `executionContext` (aiMeta.toolUsage[]).
 */
async function openaiSummarize(env, apiKey, conversation) {
  const model = resolveModel(env, 'inscricao_summary')
  const prompt = SUMMARY_PROMPT_PREFIX + conversation + SUMMARY_PROMPT_SUFFIX
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1200,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI resumo ${res.status}: ${err.slice(0, 200)}`)
  }
  const data = await res.json()
  return {
    content: data.choices?.[0]?.message?.content || '',
    model,
    usage: data.usage || null,
  }
}

async function kommoFetch(base, token, path, { method = 'GET', body } = {}) {
  const url = `${base.replace(/\/$/, '')}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

/**
 * @param {string} [extraPrefer] — ex.: "resolution=merge-duplicates" (upsert em conflito de PK/unique)
 */
async function supabaseRest(url, key, method, pathAndQuery, body, extraPrefer) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  }
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    headers.Prefer = extraPrefer ? `return=minimal,${extraPrefer}` : 'return=minimal'
  }
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${pathAndQuery}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${pathAndQuery} ${res.status}: ${text.slice(0, 220)}`)
  }
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

/**
 * @param {Record<string, string>} env
 * @param {object} body
 */
export async function runInscricao(env, body) {
  const curso = String(body?.curso ?? body?.Curso ?? '').trim()
  const tipoRaw = String(
    body?.tipo_ingresso ?? body?.tipoIngresso ?? body?.['Tipo de ingresso'] ?? getDefaultTipoIngresso(env),
  ).trim()

  const telefone = normalizeTelefone(body?.telefone)
  let idLead = normalizeIdLead(body?.id_lead ?? body?.idLead)

  if (!curso) {
    return {
      ok: false,
      code: 'MISSING_PARAMS',
      error: 'Informe o curso confirmado pelo lead.',
    }
  }

  // Reject curso obviamente alucinado ("as", "oi", strings curtas).
  // Sem isso a tool acabava gravando "Curso Inscrição: as" no Kommo.
  if (!isCursoValido(curso)) {
    return {
      ok: false,
      code: 'CURSO_INVALIDO',
      message:
        'Curso inválido — peça ao usuário o nome completo do curso (ex.: "Desenvolvimento Backend") ' +
        'antes de chamar a tool.',
      curso,
    }
  }

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_CRM_FIELDS',
      curso,
      tipo_ingresso: tipoRaw,
      message:
        'Não recebi o telefone do lead. Confirme o número (formato WhatsApp) e tente novamente.',
    }
  }

  // Mesmo padrão de distribuir_humano: se o LLM não trouxe id_lead
  // (ou trouxe 0), procura pelo telefone no Kommo. Sem isso, no
  // caminho whatsapp, a tool retornava MISSING_CRM_FIELDS porque o
  // orquestrador raramente conhece o id_lead real.
  if (idLead == null) {
    try {
      const lookup = await findLeadByPhone(env, telefone)
      if (lookup.ok && lookup.lead?.id) {
        idLead = Number(lookup.lead.id)
      } else {
        return {
          ok: false,
          code: 'KOMMO_LEAD_NOT_FOUND',
          message:
            'Não localizei nenhum lead no CRM com esse telefone. Confirme o número ou peça ao cliente que mande mensagem pelo canal padrão.',
          telefone,
        }
      }
    } catch (e) {
      return { ok: false, code: 'KOMMO_LOOKUP_ERROR', error: e.message, telefone }
    }
  }

  const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const supabaseKey = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  const kommoBase = env.KOMMO_BASE_URL || ''
  const kommoToken = env.KOMMO_ACCESS_TOKEN || ''
  const botId = Number(
    env.KOMMO_SALESBOT_MATRICULA_POS_FORM_ID ||
      env.KOMMO_SALESBOT_MATRICULA_ID ||
      env.KOMMO_SALESBOT_BOT_ID ||
      env.KOMMO_SALESBOT_BOT_ID_MATRICULA ||
      49813,
  )
  const pipelineId = Number(env.KOMMO_PIPELINE_ID || 5481944)
  const statusAguardandoInscricao = Number(
    env.KOMMO_STATUS_AGUARDANDO_INSCRICAO || DEFAULT_STATUS_AGUARDANDO_INSCRICAO,
  )
  const openaiKey = env.OPENAI_API_KEY

  if (!kommoBase || !kommoToken) {
    return {
      ok: false,
      code: 'KOMMO_NOT_CONFIGURED',
      error: 'Configure KOMMO_BASE_URL e KOMMO_ACCESS_TOKEN no servidor.',
    }
  }
  if (!supabaseUrl || !supabaseKey) {
    return {
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      error: 'Configure SUPABASE_URL e SUPABASE_KEY (projeto com inscricao_ab, dados_cliente, chat_messages).',
    }
  }
  if (!openaiKey) {
    return { ok: false, code: 'OPENAI_NOT_CONFIGURED', error: 'OPENAI_API_KEY não configurada.' }
  }

  const steps = []
  const warnings = []

  // 1) chat_messages + lead Kommo EM PARALELO. O lead Kommo serve
  // como fallback do nome do candidato quando o resumo do LLM não
  // consegue extrair "Nome do candidato:" da conversa (caminho
  // comum: o cliente nunca digita o próprio nome no whatsapp).
  const enc = encodeURIComponent(telefone)
  const [messagesRes, leadKommoRes] = await Promise.all([
    supabaseRest(
      supabaseUrl,
      supabaseKey,
      'GET',
      `chat_messages?phone=eq.${enc}&select=*&order=created_at.asc&limit=500`,
    )
      .then((rows) => ({ ok: true, rows: Array.isArray(rows) ? rows : [] }))
      .catch((e) => ({ ok: false, error: e.message })),
    kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}?with=contacts`, { method: 'GET' })
      .then((r) => ({ ok: r.ok, status: r.status, text: r.text }))
      .catch((e) => ({ ok: false, error: e.message })),
  ])

  let messages = []
  if (messagesRes.ok) {
    messages = messagesRes.rows
    steps.push({ step: 'supabase_chat_messages', ok: true, count: messages.length })
  } else {
    warnings.push(`chat_messages: ${messagesRes.error}`)
    steps.push({ step: 'supabase_chat_messages', ok: false })
  }

  // Extrai nome do lead/contato Kommo (lead.name ou primeiro contato).
  let nomeKommoFallback = ''
  if (leadKommoRes.ok) {
    try {
      const leadData = JSON.parse(leadKommoRes.text)
      if (leadData?.name && String(leadData.name).trim()) {
        nomeKommoFallback = String(leadData.name).trim()
      }
      const contact = leadData?._embedded?.contacts?.[0]
      if (!nomeKommoFallback && contact?.name) {
        nomeKommoFallback = String(contact.name).trim()
      }
      steps.push({ step: 'kommo_get_lead', ok: true, nome_fallback: nomeKommoFallback || null })
    } catch {
      steps.push({ step: 'kommo_get_lead', ok: false, error: 'parse' })
    }
  } else {
    steps.push({ step: 'kommo_get_lead', ok: false })
  }

  const conversation = buildConversationFromMessages(messages)
  let summaryText = ''
  let parsed = null
  /** @type {{ model: string, usage: object }|null} */
  let summaryUsageInfo = null
  if (conversation.trim()) {
    try {
      const r = await openaiSummarize(env, openaiKey, conversation)
      summaryText = r.content
      summaryUsageInfo = { model: r.model, usage: r.usage }
      parsed = parseResumoCampos(summaryText)
      steps.push({ step: 'openai_resumo', ok: true, model: r.model })
    } catch (e) {
      warnings.push(`resumo: ${e.message}`)
      steps.push({ step: 'openai_resumo', ok: false, error: e.message })
    }
  } else {
    warnings.push('Sem mensagens em chat_messages para resumir.')
    parsed = {
      resumo: 'Sem histórico de chat disponível.',
      nome_candidato: 'Não informado',
      nivel: 'Não informado',
      curso,
      informacoes_ia: 'Não informado',
      status_conversa: 'Não informado',
      texto_original: '',
    }
    summaryText = `Resumo: Sem histórico de chat.\nNome do candidato: Não informado\nNível: Não informado\nCurso: ${curso}\nInformações fornecidas pela IA: Não informado\nStatus da conversa: Não informado`
  }

  if (!parsed) {
    warnings.push('Resumo não disponível; usando valores padrão para CRM.')
    parsed = {
      resumo: summaryText || `Inscrição — lead ${idLead}.`,
      nome_candidato: 'Não informado',
      nivel: 'Não informado',
      curso,
      informacoes_ia: 'Não informado',
      status_conversa: 'Não informado',
      texto_original: '',
    }
  }

  if (String(env.INSCRICAO_TEST_OVERRIDES || '').toLowerCase() === 'true') {
    const testNome = String(body?._test_nome_candidato ?? '').trim()
    const testNivel = String(body?._test_nivel ?? '').trim()
    if (testNome && testNivel) {
      parsed = { ...parsed, nome_candidato: testNome, nivel: testNivel }
      warnings.push(
        '[TESTE] Nome e nível vindos de _test_nome_candidato / _test_nivel — INSCRICAO_TEST_OVERRIDES não use em produção.',
      )
    }
  }

  // Fallback do nome: se o resumo não extraiu o nome do candidato da
  // conversa (caso comum — o lead raramente diz o próprio nome no
  // whatsapp), usa o nome do lead/contato registrado no Kommo.
  if (isCampoAusente(parsed.nome_candidato) && nomeKommoFallback) {
    parsed.nome_candidato = nomeKommoFallback
  }

  // Inferência simples de nível pelo curso quando o resumo não
  // identificou. Cobre os casos mais comuns sem precisar de outro LLM.
  if (isCampoAusente(parsed.nivel)) {
    const c = curso.toLowerCase()
    if (/(mba|mestrad|doutorad|p[óo]s[\s-]?gradua|especializa)/.test(c)) {
      parsed.nivel = 'Pós-graduação'
    } else {
      parsed.nivel = 'Graduação'
    }
  }

  const missingFields = []
  if (isCampoAusente(parsed.nome_candidato)) missingFields.push('Nome do candidato')
  if (isCampoAusente(parsed.nivel)) missingFields.push('Nível de interesse')

  // O LLM só chama a tool inscricao quando o lead confirmou que
  // quer se inscrever. Antes a tool podia "rebaixar" pra atendimento
  // se faltasse algum dado no resumo — isso fazia leads válidos
  // ficarem no funil errado. Agora o destino é SEMPRE Aguardando
  // Inscrição; campos faltantes viram só uma nota informativa.
  const destino = 'aguardando_inscricao'

  // 2-4) Salesbot + inscricao_ab + dados_cliente pause em PARALELO.
  // Como destino agora é sempre 'aguardando_inscricao', removemos
  // o ramo "skipped". As 3 operações são independentes — antes em
  // série gastavam ~2-3s extras.
  const encTel = encodeURIComponent(telefone)
  const [salesbotRes, inscricaoAbRes, dadosClienteRes] = await Promise.all([
    runKommoSalesbot(env, idLead, 'matricula_pos_form').then((r) => ({
      ok: r.ok,
      status: r.status,
      text: r.text || '',
      botId: r.botId,
    })),
    supabaseRest(
      supabaseUrl,
      supabaseKey,
      'POST',
      'inscricao_ab',
      [{ id_lead: idLead, Atendimento: 'IA' }],
      'resolution=merge-duplicates',
    )
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: e.message })),
    supabaseRest(supabaseUrl, supabaseKey, 'PATCH', `dados_cliente?telefone=eq.${encTel}`, {
      atendimento_ia: 'pause',
    })
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: e.message })),
  ])

  steps.push({
    step: 'kommo_salesbot',
    ok: salesbotRes.ok,
    status: salesbotRes.status,
    bot_id: salesbotRes.botId || botId,
    motivo: 'matricula',
  })
  if (!salesbotRes.ok) {
    // Salesbot pode falhar por motivos benignos (bot já rodando,
    // permissão, etc.). Não bloqueia o resto do fluxo — só registra.
    warnings.push(`kommo_salesbot: ${salesbotRes.text.slice(0, 200)}`)
  }
  steps.push({ step: 'supabase_inscricao_ab', ok: inscricaoAbRes.ok })
  if (!inscricaoAbRes.ok) warnings.push(`inscricao_ab: ${inscricaoAbRes.error}`)
  steps.push({ step: 'supabase_dados_cliente_pause', ok: dadosClienteRes.ok })
  if (!dadosClienteRes.ok) warnings.push(`dados_cliente: ${dadosClienteRes.error}`)

  const nomeKommo = isCampoAusente(parsed.nome_candidato)
    ? 'Não informado'
    : String(parsed.nome_candidato).trim()
  const nivelKommo = isCampoAusente(parsed.nivel)
    ? 'Não informado'
    : String(parsed.nivel).trim()
  const poloKommo = 'polo mais próximo'

  // Descobre os IDs dos campos da seção "Inscrição" via API do Kommo
  // (listagem cacheada por 5min). Antes a tool só atualizava o campo
  // "Curso" (id 31782) e o cliente percebia que "Curso Inscrição" não
  // mudava. Agora preenche os dois quando ambos existem.
  const fieldsLookup = await listLeadCustomFields(env).catch(() => ({ ok: false }))
  const fieldsByName = fieldsLookup.ok ? fieldsLookup.byName : null
  // Index por ID (mesmo conteúdo, chaveado por id) — usado pelo
  // resolveFieldDef quando temos um hardcode/env e queremos saber se
  // o campo é text/select pra montar o PATCH corretamente.
  const fieldsById = fieldsLookup.ok
    ? new Map(Array.from(fieldsByName.values()).map((d) => [d.id, d]))
    : null
  steps.push({
    step: 'kommo_lead_custom_fields',
    ok: fieldsLookup.ok,
    cached: fieldsLookup.cached,
    total: fieldsLookup.raw?.length || 0,
  })

  const cursoInscricaoDef = resolveFieldDef(
    env,
    'KOMMO_FIELD_CURSO_INSCRICAO_ID',
    KOMMO_FIELD_CURSO_INSCRICAO_DEFAULT,
    FIELD_NAME_ALIASES.cursoInscricao,
    fieldsByName,
    fieldsById,
  )
  const poloInscricaoDef = resolveFieldDef(
    env,
    'KOMMO_FIELD_POLO_INSCRICAO_ID',
    KOMMO_FIELD_POLO_INSCRICAO_DEFAULT,
    FIELD_NAME_ALIASES.poloInscricao,
    fieldsByName,
    fieldsById,
  )
  const tipoInscricaoDef = resolveFieldDef(
    env,
    'KOMMO_FIELD_TIPO_INSCRICAO_ID',
    KOMMO_FIELD_TIPO_INSCRICAO_DEFAULT,
    FIELD_NAME_ALIASES.tipoInscricao,
    fieldsByName,
    fieldsById,
  )

  const customFields = [
    { field_id: KOMMO_FIELD_CURSO, values: [{ value: curso }] },
    { field_id: KOMMO_FIELD_NIVEL, values: [{ value: nivelKommo }] },
    { field_id: KOMMO_FIELD_NOME, values: [{ value: nomeKommo }] },
  ]

  // "Polo Inscrição" e "Tipo Inscrição" — usar IDs descobertos. Se
  // forem do tipo `select`, mapeia o valor textual pra `enum_id`
  // automaticamente. Se não acharmos o nome no Kommo, registra um
  // warning mas não bloqueia (o resto dos campos vai do mesmo jeito).
  const poloEntry = buildCustomFieldEntry(poloInscricaoDef, poloKommo)
  if (poloEntry) {
    customFields.push(poloEntry)
  } else if (poloInscricaoDef) {
    warnings.push(`polo: enum não encontrado no Kommo (campo "${poloInscricaoDef.name}")`)
  } else {
    warnings.push('polo: campo "Polo Inscrição" não encontrado no Kommo')
  }

  const tipoEntry = buildCustomFieldEntry(tipoInscricaoDef, tipoRaw)
  if (tipoEntry) {
    customFields.push(tipoEntry)
  } else if (tipoInscricaoDef) {
    warnings.push(`tipo_ingresso: enum não encontrado (campo "${tipoInscricaoDef.name}", valor "${tipoRaw}")`)
  } else {
    warnings.push('tipo_ingresso: campo "Tipo Inscrição" não encontrado no Kommo')
  }

  // "Curso Inscrição" — campo dedicado da seção de inscrição. Antes
  // não era atualizado e ficava com resíduo do salesbot.
  const cursoInscricaoEntry = buildCustomFieldEntry(cursoInscricaoDef, curso)
  if (cursoInscricaoEntry) {
    customFields.push(cursoInscricaoEntry)
  } else if (cursoInscricaoDef) {
    warnings.push(`curso_inscricao: enum não encontrado (campo "${cursoInscricaoDef.name}", valor "${curso}")`)
  } else {
    warnings.push('curso_inscricao: campo "Curso Inscrição" não encontrado no Kommo')
  }

  // 5-6) Notas + PATCH do lead (campos + pipeline/status) em PARALELO.
  // Antes a tool fazia em série; ambos só dependem do idLead que já temos.
  const notas = []
  if (parsed.resumo) {
    notas.push({ note_type: 'common', params: { text: String(parsed.resumo) } })
  }
  if (missingFields.length > 0) {
    notas.push({
      note_type: 'common',
      params: {
        text:
          '[Inscrição automática] Lead movido para Aguardando Inscrição com dados parciais. ' +
          'Pendências detectadas no resumo: ' +
          missingFields.join(', ') +
          '. Completar no CRM ou no atendimento humano.',
      },
    })
  }

  const notePromise = notas.length > 0
    ? kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}/notes`, {
        method: 'POST',
        body: notas,
      })
    : Promise.resolve(null)

  const patchPromise = kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}`, {
    method: 'PATCH',
    body: {
      pipeline_id: pipelineId,
      status_id: statusAguardandoInscricao,
      custom_fields_values: customFields,
    },
  })

  const [noteRes, patchRes] = await Promise.all([notePromise, patchPromise])
  if (noteRes) {
    steps.push({ step: 'kommo_note', ok: noteRes.ok, status: noteRes.status })
    if (!noteRes.ok) warnings.push(`kommo_note: ${noteRes.text.slice(0, 200)}`)
  }
  steps.push({ step: 'kommo_update_lead', ok: patchRes.ok, status: patchRes.status })
  if (!patchRes.ok) warnings.push(`kommo_update_lead: ${patchRes.text.slice(0, 300)}`)

  return {
    ok: true,
    retorno: 'Lead movido para Aguardando Inscrição.',
    destino,
    missing_fields: missingFields.length ? missingFields : undefined,
    curso,
    tipo_ingresso: tipoRaw,
    id_lead: idLead,
    resumo_campos: parsed,
    texto_resumo_ia: summaryText,
    warnings,
    steps,
    // _meta: usado pelo executor (toolExecutorsServer) para empurrar
    // o usage do LLM auxiliar no executionContext (custo total real).
    _meta: summaryUsageInfo
      ? { toolUsage: [{ tool: 'inscricao', model: summaryUsageInfo.model, usage: summaryUsageInfo.usage }] }
      : undefined,
  }
}

export function formatInscricaoToolReply(result) {
  if (!result.ok) {
    if (result.code === 'MISSING_CRM_FIELDS') {
      return [
        '[Inscrição — aguardando CRM]',
        result.message,
        `Curso recebido: ${result.curso}`,
        `Tipo de ingresso: ${result.tipo_ingresso}`,
        'Quando telefone e id_lead estiverem disponíveis no contexto do atendimento, o fluxo poderá disparar o template WhatsApp e atualizar Kommo/Supabase automaticamente.',
      ].join('\n')
    }
    return `Inscrição não executada: ${result.error || result.code || 'erro desconhecido'}`
  }
  const lines = [
    result.retorno || 'Inscrição processada.',
    `Curso: ${result.curso}`,
    `Tipo de ingresso: ${result.tipo_ingresso}`,
  ]
  if (result.destino === 'aguardando_inscricao') {
    lines.push('Destino no CRM: Aguardando Inscrição.')
  } else if (result.destino === 'atendimento') {
    lines.push('Destino no CRM: atendimento (consultor).')
  }
  if (result.missing_fields?.length) {
    lines.push(`Pendências registradas na nota: ${result.missing_fields.join(', ')}`)
  }
  if (result.resumo_campos?.resumo) {
    lines.push(`Resumo para o CRM: ${result.resumo_campos.resumo}`)
  }
  if (result.warnings?.length) {
    lines.push(`Avisos: ${result.warnings.join(' | ')}`)
  }
  return lines.join('\n')
}
