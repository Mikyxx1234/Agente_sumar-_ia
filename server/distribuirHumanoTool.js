/**
 * Tool distribuir_humano — espelha tool distribuir.txt (n8n Execute Workflow).
 *
 * Entradas: id_lead, telefone (Kommo + WhatsApp).
 * Supabase principal (AGENTE COMERCIAL): dados_cliente, chat_messages, distribuicao_por_consultor.
 * Supabase consultores: tabela distrib_comercial (projeto “acadêmico” — env separado).
 *
 * Env:
 *   KOMMO_BASE_URL, KOMMO_ACCESS_TOKEN
 *   SUPABASE_URL, SUPABASE_KEY — principal (chat, dados_cliente, distribuicao_por_consultor)
 *   distrib_comercial: mesmo projeto do feedback por padrão (SUPABASE_*_FEEDBACK);
 *     ou override com SUPABASE_URL_DIST_COMERCIAL / SUPABASE_KEY_DIST_COMERCIAL
 *   OPENAI_API_KEY
 *   Opcionais: KOMMO_DISTRIB_* (IDs abaixo têm default do fluxo n8n)
 */

import { resolveModel } from './ai/modelRegistry.js'
import { findLeadByPhone } from './kommoClient.js'
import { runKommoSalesbot, normalizeSalesbotMotivo } from './kommoSalesbot.js'

const DEFAULT_DISTRIB_PIPELINE_ID = 11685120
const DEFAULT_DISTRIB_STATUS_IDS = [89820300, 89820304]
const DEFAULT_ASSIGN_STATUS_ID = 89820300
const DEFAULT_FINAL_PIPELINE_ID = 5481944
const DEFAULT_FINAL_STATUS_ID = 48539246
const DEFAULT_FIELD_ORIGEM_SELECT = 686789
const KOMMO_FIELD_CURSO = 31782
const KOMMO_FIELD_NIVEL = 31786

const DISTRIB_PROMPT_PREFIX = `Prompt para Agente de Resumo de Conversas
Você é um assistente especializado em resumir conversas do WhatsApp entre o assistente virtual comercial da Faculdade Sumaré e candidatos.

Sua Tarefa
Analise a conversa completa abaixo e crie um resumo estruturado:

`

const DISTRIB_PROMPT_SUFFIX = `

Informações para Identificar
INSTRUÇÕES CRÍTICAS DE ANÁLISE:

Leia TODA a conversa linha por linha antes de fazer o resumo
Extraia informações REAIS que aparecem nas mensagens, não invente ou generalize
Se o candidato mencionar seu nome em qualquer momento, capture-o
Se o candidato perguntar sobre um curso específico, identifique qual curso
Se o candidato perguntar sobre valores, isso indica interesse claro
NUNCA invente nomes de candidatos - use APENAS o nome que o próprio candidato informou explicitamente
NUNCA assuma informações que não foram trocadas - se o assistente não respondeu ainda, informe isso claramente
Identifique quem falou o quê - diferencie mensagens do candidato das mensagens do assistente/robô
O que procurar:

Nome do candidato: Qualquer menção ao nome (completo ou primeiro nome) nas mensagens do candidato ou quando o assistente se dirige ao candidato
Nível de interesse: Baseado no tipo de curso mencionado (graduação, pós-graduação)
Curso específico: Nome exato do curso que o candidato perguntou ou demonstrou interesse
Informações fornecidas: Valores específicos, prazos, links, documentos, detalhes de inscrição que o assistente compartilhou
Perguntas do candidato: O que especificamente o candidato quis saber
Status: Se o candidato ainda está respondendo ou parou de responder
REGRA CRÍTICA PARA CONVERSAS SEM RESPOSTA DO ASSISTENTE:

Se o assistente NÃO respondeu às perguntas do candidato ainda, você DEVE informar: "O assistente ainda não respondeu ao candidato"
Se o candidato apenas enviou uma pergunta e não houve troca de mensagens, informe: "Não houve troca de mensagens ainda. O candidato perguntou sobre [assunto]"
NÃO invente informações que não foram fornecidas pelo assistente
Classificação de Níveis
Graduação: Bacharelado, licenciatura, tecnólogo (ex: Administração, Engenharia, Direito, Psicologia, Enfermagem)
Pós-graduação: MBA, especialização, mestrado, doutorado
Não informado: Quando não fica claro o nível de interesse
Formato de Resposta Obrigatório
Resumo: [2-6 frases descrevendo o que REALMENTE aconteceu na conversa com base nas mensagens trocadas. Inclua o nome se foi mencionado, o curso específico sobre o qual perguntaram, e as principais informações fornecidas. Seja específico e factual. Se não houve resposta do assistente, informe isso claramente.] Nome do candidato: [Nome identificado na conversa ou "Não informado"] Nível: [Graduação/Pós-graduação/Não informado] Curso: [Nome exato do curso mencionado na conversa ou "Não informado"] Informações fornecidas pela IA: [Liste especificamente o que a IA compartilhou: valores mencionados, links enviados, documentos solicitados, prazos informados, etc. Se a IA não respondeu ainda, escreva: "Nenhuma informação fornecida ainda - aguardando resposta do assistente"] Status da conversa: [Candidato respondeu/Candidato parou de responder/Aguardando resposta do assistente]
IMPORTANTE:

Responda APENAS no formato acima, sem repetir estas instruções
Base seu resumo EXCLUSIVAMENTE no conteúdo real das mensagens
NÃO generalize dizendo "candidato demonstrou interesse em cursos" se ele perguntou sobre um curso específico
NÃO diga "não teve o nome mencionado" se o nome aparece na conversa
Seja preciso e específico com as informações que realmente foram trocadas
NUNCA invente nomes, valores, ou informações que não aparecem explicitamente nas mensagens
Se o assistente não respondeu, deixe claro que não houve resposta ainda
`

function normalizeTelefone(t) {
  if (t == null) return ''
  return String(t).trim()
}

function normalizeIdLead(id) {
  if (id == null || id === '') return null
  const n = Number(id)
  return Number.isFinite(n) ? n : null
}

function formatTelefoneDigits(telefoneOriginal) {
  let telefone = String(telefoneOriginal || '').replace(/\D/g, '')
  if (telefone.startsWith('55') && telefone.length > 11) {
    telefone = telefone.slice(2)
  }
  return telefone
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseResumoCamposDistribuicao(inputText) {
  const labels = [
    'Resumo',
    'Nome do candidato',
    'Nível',
    'Curso',
    'Informações fornecidas pela IA',
    'Status da conversa',
  ]
  const text = String(inputText || '')
  if (!text) {
    return {
      resumo: '',
      nome_candidato: '',
      nivel: '',
      curso: '',
      informacoes_ia: '',
      status_conversa: '',
      texto_original: text,
    }
  }
  const positions = []
  for (const label of labels) {
    const regex = new RegExp(`\\*{0,2}\\s*${escapeRegex(label)}\\s*\\*{0,2}\\s*:`, 'i')
    const m = regex.exec(text)
    if (m) positions.push({ label, idx: m.index, length: m[0].length })
  }
  if (positions.length === 0) {
    return {
      resumo: '',
      nome_candidato: '',
      nivel: '',
      curso: '',
      informacoes_ia: '',
      status_conversa: '',
      texto_original: text,
    }
  }
  positions.sort((a, b) => a.idx - b.idx)
  const extracted = {}
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].idx + positions[i].length
    const end = i + 1 < positions.length ? positions[i + 1].idx : text.length
    const value = text
      .slice(start, end)
      .trim()
      .replace(/\s+\n\s+/g, '\n')
      .replace(/\s{2,}/g, ' ')
    extracted[positions[i].label] = value
  }
  return {
    resumo: extracted['Resumo'] || '',
    nome_candidato: extracted['Nome do candidato'] || '',
    nivel: extracted['Nível'] || '',
    curso: extracted['Curso'] || '',
    informacoes_ia: extracted['Informações fornecidas pela IA'] || '',
    status_conversa: extracted['Status da conversa'] || '',
    texto_original: text,
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

function pickConsultorDistribuicao(rows, topN = 5) {
  const normNome = (v) => (v ?? '').trim().toLowerCase()
  const getKey = (j) => j.id_lead ?? normNome(j.nome ?? j.Nome)
  const getTs = (j) => {
    const s = j.ultimo_lead ?? j['Ultimo Lead'] ?? j.ultimoLead
    const t = Date.parse(s)
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t
  }
  const byConsultor = new Map()
  for (let i = 0; i < rows.length; i++) {
    const j = rows[i]
    const keyRaw = getKey(j)
    const key = keyRaw == null || keyRaw === '' ? `__sem_chave_${i}` : String(keyRaw)
    const ts = getTs(j)
    const cur = byConsultor.get(key)
    if (!cur || ts < cur.ts) {
      byConsultor.set(key, { idx: i, row: j, ts })
    }
  }
  const unicos = Array.from(byConsultor.values())
  if (unicos.length === 0) throw new Error('Nenhum consultor disponível para distribuição.')
  unicos.sort((a, b) => a.ts - b.ts)
  const take = Math.min(topN, unicos.length)
  const candidatos = unicos.slice(0, take)
  return candidatos[Math.floor(Math.random() * candidatos.length)].row
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
 * Resume conversa para distribuir ao consultor humano.
 * Retorna { content, model, usage } para acumular custo no aiMeta.
 */
async function openaiDistribuirResumo(env, apiKey, conversation) {
  const model = resolveModel(env, 'distribuir_humano_summary')
  const prompt = DISTRIB_PROMPT_PREFIX + conversation + DISTRIB_PROMPT_SUFFIX
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 1200,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`)
  }
  const data = await res.json()
  return {
    content: data.choices?.[0]?.message?.content || '',
    model,
    usage: data.usage || null,
  }
}

function parseLeadFromKommoGet(data) {
  const lead = data?._embedded?.leads?.[0] ?? (data?.id != null ? data : null)
  if (!lead || lead.id == null) return null
  return lead
}

/** `minimal` = salesbot + pause IA (Sumaré). `full` = fluxo n8n legado com funil Cruzeiro. */
export function resolveDistribHandoffMode(env) {
  const m = String(env.KOMMO_DISTRIB_HANDOFF_MODE || 'minimal')
    .trim()
    .toLowerCase()
  if (['full', 'legacy', 'n8n', 'completo'].includes(m)) return 'full'
  return 'minimal'
}

/**
 * Encaminhamento Sumaré: dispara salesbot (49777 consultor / Formulario_Sum / 49815 pós-form), pausa IA e registra nota.
 * Não move pipeline nem exige distrib_comercial — evita funil errado e falhas antes do bot.
 */
async function runMinimalDistribuirHandoff(env, ctx) {
  const {
    telefone,
    idLead,
    motivoFluxo,
    kommoBase,
    kommoToken,
    mainUrl,
    mainKey,
    cursoHint,
    tipoIngressoHint,
  } = ctx
  const steps = []
  const warnings = []
  const kind = normalizeSalesbotMotivo(motivoFluxo)

  const [salesbotRes, dadosClienteRes] = await Promise.all([
    runKommoSalesbot(env, idLead, motivoFluxo),
    (async () => {
      try {
        const enc = encodeURIComponent(telefone)
        await supabaseRest(mainUrl, mainKey, 'PATCH', `dados_cliente?telefone=eq.${enc}`, {
          atendimento_ia: 'pause',
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    })(),
  ])

  steps.push({
    step: 'kommo_salesbot',
    ok: salesbotRes.ok,
    status: salesbotRes.status,
    bot_id: salesbotRes.botId,
    motivo: salesbotRes.motivo || motivoFluxo,
    skipped: salesbotRes.skipped || false,
  })
  if (!salesbotRes.ok && !salesbotRes.skipped) {
    warnings.push(`kommo_salesbot: ${(salesbotRes.text || '').slice(0, 200)}`)
  }

  steps.push({ step: 'supabase_dados_cliente_pause', ok: dadosClienteRes.ok })
  if (!dadosClienteRes.ok) warnings.push(`dados_cliente: ${dadosClienteRes.error}`)

  let noteText =
    kind === 'matricula_pos_form'
      ? 'Form Sumar preenchido — salesbot pós-formulário disparado (agente IA).'
      : kind === 'formulario_sum'
        ? 'Inscrição — salesbot Formulario_Sum ativado (agente IA).'
        : 'Encaminhamento automático: lead pediu atendimento humano via WhatsApp (agente IA).'
  if (cursoHint) noteText += `\nCurso mencionado: ${String(cursoHint).trim()}`
  if (tipoIngressoHint) noteText += `\nIngresso: ${String(tipoIngressoHint).trim()}`

  const openaiKey = env.OPENAI_API_KEY
  const phoneQueries = [...new Set([telefone, formatTelefoneDigits(telefone), `+55${formatTelefoneDigits(telefone)}`])].filter(
    Boolean,
  )
  if (openaiKey) {
    try {
      const tasks = phoneQueries.map(async (q) => {
        try {
          const enc = encodeURIComponent(q)
          const rowsMsg = await supabaseRest(
            mainUrl,
            mainKey,
            'GET',
            `chat_messages?phone=eq.${enc}&select=*&order=created_at.asc&limit=500`,
          )
          return Array.isArray(rowsMsg) ? rowsMsg : []
        } catch {
          return []
        }
      })
      const results = await Promise.all(tasks)
      const messages = results.find((r) => r.length > 0) || []
      steps.push({ step: 'supabase_chat_messages', ok: true, count: messages.length })
      const conversation = buildConversationFromMessages(messages)
      if (conversation.trim()) {
        try {
          const r = await openaiDistribuirResumo(env, openaiKey, conversation)
          const parsed = parseResumoCamposDistribuicao(r.content)
          if (parsed.resumo) noteText = parsed.resumo
          steps.push({ step: 'openai_resumo', ok: true, model: r.model })
        } catch (e) {
          warnings.push(`openai: ${e.message}`)
          steps.push({ step: 'openai_resumo', ok: false })
        }
      }
    } catch (e) {
      warnings.push(`chat_messages: ${e.message}`)
    }
  }

  const noteRes = await kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}/notes`, {
    method: 'POST',
    body: [{ note_type: 'common', params: { text: noteText } }],
  })
  steps.push({ step: 'kommo_note', ok: noteRes.ok, status: noteRes.status })
  if (!noteRes.ok) warnings.push(`kommo_note: ${noteRes.text.slice(0, 200)}`)

  const ok = Boolean(salesbotRes.ok && !salesbotRes.skipped)
  return {
    ok,
    handoff_mode: 'minimal',
    retorno: ok
      ? kind === 'matricula_pos_form'
        ? 'salesbot pós-formulário (matrícula) disparado; IA pausada'
        : kind === 'formulario_sum'
          ? 'salesbot Formulario_Sum disparado'
          : 'salesbot consultor disparado; IA pausada'
      : 'encaminhamento parcial (verifique salesbot no Kommo)',
    id_lead: idLead,
    motivo: kind,
    warnings,
    steps,
  }
}

/**
 * @param {Record<string, string>} env
 * @param {object} body
 */
export async function runDistribuirHumano(env, body) {
  const telefone = normalizeTelefone(body?.telefone)
  const motivoFluxo = body?.motivo ?? body?.fluxo ?? 'consultor'
  let idLead = normalizeIdLead(body?.id_lead ?? body?.idLead)
  // O LLM frequentemente chama a tool com id_lead = 0 (default da
  // OpenAI quando ele não tem o ID no contexto). Tratamos 0/negativo
  // como "ausente" e tentamos resolver pelo telefone — assim a tool
  // funciona mesmo sem o id_lead vir do orquestrador.
  if (idLead == null || idLead <= 0) idLead = null

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_CRM_FIELDS',
      message:
        'Informe o telefone do lead para distribuir o atendimento humano.',
      telefone: null,
      id_lead: idLead,
    }
  }

  const kommoBase = env.KOMMO_BASE_URL || ''
  const kommoToken = env.KOMMO_ACCESS_TOKEN || ''
  const mainUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const mainKey = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  const distUrl =
    env.SUPABASE_URL_DIST_COMERCIAL ||
    env.SUPABASE_URL_FEEDBACK ||
    env.VITE_SUPABASE_URL_FEEDBACK ||
    ''
  const distKey =
    env.SUPABASE_KEY_DIST_COMERCIAL ||
    env.SUPABASE_KEY_FEEDBACK ||
    env.VITE_SUPABASE_KEY_FEEDBACK ||
    ''
  const openaiKey = env.OPENAI_API_KEY

  const distribPipelineId = Number(env.KOMMO_DISTRIB_PIPELINE_ID || DEFAULT_DISTRIB_PIPELINE_ID)
  const distribStatusIds = String(env.KOMMO_DISTRIB_STATUS_IDS || DEFAULT_DISTRIB_STATUS_IDS.join(','))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
  const assignStatusId = Number(env.KOMMO_DISTRIB_ASSIGN_STATUS_ID || DEFAULT_ASSIGN_STATUS_ID)
  const finalPipelineId = Number(env.KOMMO_DISTRIB_FINAL_PIPELINE_ID || DEFAULT_FINAL_PIPELINE_ID)
  const finalStatusId = Number(env.KOMMO_DISTRIB_FINAL_STATUS_ID || DEFAULT_FINAL_STATUS_ID)
  const fieldOrigem = Number(env.KOMMO_FIELD_DIST_ORIGEM || DEFAULT_FIELD_ORIGEM_SELECT)
  const topN = Number(env.DIST_CONSULTOR_TOP_N || 5) || 5

  if (!kommoBase || !kommoToken) {
    return { ok: false, code: 'KOMMO_NOT_CONFIGURED', error: 'Configure KOMMO_BASE_URL e KOMMO_ACCESS_TOKEN.' }
  }
  if (!mainUrl || !mainKey) {
    return { ok: false, code: 'SUPABASE_NOT_CONFIGURED', error: 'Configure SUPABASE_URL e SUPABASE_KEY.' }
  }

  const handoffMode = resolveDistribHandoffMode(env)
  const steps = []
  const warnings = []

  // Se o LLM não trouxe id_lead, resolvemos via telefone no Kommo.
  // (No fluxo WhatsApp a busca pelo telefone já foi feita pelo
  // scheduler, mas como a tool é stateless, precisamos refazer aqui
  // sempre que id_lead estiver faltando.)
  if (idLead == null) {
    try {
      const lookup = await findLeadByPhone(env, telefone)
      if (lookup.ok && lookup.lead?.id) {
        idLead = Number(lookup.lead.id)
        steps.push({ step: 'kommo_lookup_by_phone', ok: true, id_lead: idLead })
      } else {
        steps.push({ step: 'kommo_lookup_by_phone', ok: false, matched: lookup.matched || 0 })
        return {
          ok: false,
          code: 'KOMMO_LEAD_NOT_FOUND',
          message: 'Não localizei nenhum lead no CRM com esse telefone. Confirme o número ou peça pra ele entrar em contato pelo canal padrão.',
          steps,
        }
      }
    } catch (e) {
      steps.push({ step: 'kommo_lookup_by_phone', ok: false, error: e.message })
      return { ok: false, code: 'KOMMO_LOOKUP_ERROR', error: e.message, steps }
    }
  }

  if (handoffMode === 'minimal') {
    return runMinimalDistribuirHandoff(env, {
      telefone,
      idLead,
      motivoFluxo,
      kommoBase,
      kommoToken,
      mainUrl,
      mainKey,
      cursoHint: body?.curso ?? body?.nome_curso,
      tipoIngressoHint: body?.tipo_ingresso ?? body?.tipoIngresso ?? body?.ingresso,
    })
  }

  if (!distUrl || !distKey) {
    return {
      ok: false,
      code: 'DIST_COMERCIAL_NOT_CONFIGURED',
      error:
        'Configure tabela distrib_comercial: use SUPABASE_URL_FEEDBACK + SUPABASE_KEY_FEEDBACK (mesmo projeto do feedback) ' +
        'ou SUPABASE_URL_DIST_COMERCIAL + SUPABASE_KEY_DIST_COMERCIAL.',
    }
  }
  if (!openaiKey) {
    return { ok: false, code: 'OPENAI_NOT_CONFIGURED', error: 'OPENAI_API_KEY não configurada.' }
  }

  // Buscar dados do lead no Kommo + lista de consultores no Supabase
  // EM PARALELO. As duas requisições são independentes — só precisam
  // estar prontas antes de decidir pra quem distribuir.
  const [leadGet, consultoresRes] = await Promise.all([
    kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}?with=contacts`, { method: 'GET' }),
    supabaseRest(distUrl, distKey, 'GET', 'distrib_comercial?status=eq.ATIVO&select=*')
      .then((r) => ({ ok: true, rows: Array.isArray(r) ? r : [] }))
      .catch((e) => ({ ok: false, error: e.message })),
  ])

  steps.push({ step: 'kommo_get_lead', ok: leadGet.ok, status: leadGet.status })
  if (!leadGet.ok) {
    return {
      ok: false,
      code: 'KOMMO_LEAD_NOT_FOUND',
      detail: leadGet.text.slice(0, 400),
      steps,
    }
  }

  let leadData
  try {
    leadData = JSON.parse(leadGet.text)
  } catch {
    return { ok: false, code: 'KOMMO_PARSE', error: 'Resposta inválida ao buscar lead.', steps }
  }

  const lead = parseLeadFromKommoGet(leadData)
  if (!lead) {
    return { ok: false, code: 'KOMMO_LEAD_EMPTY', error: 'Lead não encontrado na resposta.', steps }
  }

  const st = Number(lead.status_id)
  const pip = Number(lead.pipeline_id)
  // Por padrão a tool aceita qualquer pipeline/status — a função dela
  // é simplesmente mover o lead pro funil de distribuição e atribuir
  // ao consultor. Caso a operação queira voltar a ter um filtro de
  // elegibilidade (ex.: só leads "Aguardando distribuição"), basta
  // setar KOMMO_DISTRIB_REQUIRE_ELIGIBLE_STATUS=true no .env.
  const requireEligible = String(env.KOMMO_DISTRIB_REQUIRE_ELIGIBLE_STATUS || 'false').toLowerCase() === 'true'
  const eligible = pip === distribPipelineId && distribStatusIds.includes(st)
  if (requireEligible && !eligible) {
    return {
      ok: false,
      code: 'LEAD_NOT_ELIGIBLE',
      // Mensagem genérica pro LLM — sem expor IDs internos pro cliente.
      message:
        'Não foi possível encaminhar esse lead para um consultor agora. ' +
        'Continue a conversa normalmente e tente de novo mais tarde.',
      pipeline_id: pip,
      status_id: st,
      steps,
    }
  }

  const contactId = lead._embedded?.contacts?.[0]?.id
  if (contactId == null) {
    return { ok: false, code: 'KOMMO_NO_CONTACT', error: 'Lead sem contato embarcado (with=contacts).', steps }
  }

  if (!consultoresRes.ok) {
    return { ok: false, code: 'SUPABASE_DIST_COMERCIAL', error: consultoresRes.error, steps }
  }
  const rows = consultoresRes.rows
  steps.push({ step: 'supabase_distrib_comercial', ok: true, count: rows.length })
  if (rows.length === 0) {
    return { ok: false, code: 'NO_CONSULTANTS', error: 'Nenhuma linha ATIVO em distrib_comercial.', steps }
  }

  let consultorRow
  try {
    consultorRow = pickConsultorDistribuicao(rows, topN)
  } catch (e) {
    return { ok: false, code: 'CONSULTOR_PICK', error: e.message, steps }
  }

  const consultorUserId = Number(consultorRow.id_lead)
  const consultorNome = String(consultorRow.nome ?? consultorRow.Nome ?? '').trim()
  const consultorTableId = consultorRow.id
  if (!Number.isFinite(consultorUserId)) {
    return { ok: false, code: 'CONSULTOR_INVALID', error: 'Consultor sem id_lead (Kommo user id) válido.', steps }
  }

  const ultimoLeadIso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  try {
    await supabaseRest(distUrl, distKey, 'PATCH', `distrib_comercial?id=eq.${consultorTableId}`, {
      ultimo_lead: ultimoLeadIso,
    })
    steps.push({ step: 'supabase_ultimo_lead', ok: true })
  } catch (e) {
    return { ok: false, code: 'SUPABASE_ULTIMO_LEAD', error: e.message, steps }
  }

  const customOrigem = []
  const enumId = env.KOMMO_DIST_ORIGEM_ENUM_ID
  if (enumId) {
    customOrigem.push({
      field_id: fieldOrigem,
      values: [{ enum_id: Number(enumId) }],
    })
  } else {
    customOrigem.push({
      field_id: fieldOrigem,
      values: [{ value: 'Recebida' }],
    })
  }

  const assignPatch = await kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}`, {
    method: 'PATCH',
    body: {
      pipeline_id: distribPipelineId,
      status_id: assignStatusId,
      responsible_user_id: consultorUserId,
      custom_fields_values: customOrigem,
    },
  })
  steps.push({ step: 'kommo_assign_lead', ok: assignPatch.ok, status: assignPatch.status })
  if (!assignPatch.ok) {
    warnings.push(`kommo_assign_lead: ${assignPatch.text.slice(0, 300)}`)
    const salesbotOnFail = await runKommoSalesbot(env, idLead, motivoFluxo)
    steps.push({
      step: 'kommo_salesbot',
      ok: salesbotOnFail.ok,
      status: salesbotOnFail.status,
      bot_id: salesbotOnFail.botId,
      motivo: salesbotOnFail.motivo || motivoFluxo,
      after_assign_fail: true,
    })
    if (!salesbotOnFail.ok && !salesbotOnFail.skipped) {
      warnings.push(`kommo_salesbot: ${(salesbotOnFail.text || '').slice(0, 200)}`)
    }
    return {
      ok: false,
      code: 'KOMMO_ASSIGN_LEAD_FAILED',
      detail: assignPatch.text.slice(0, 400),
      steps,
    }
  }

  // Agora que o lead já foi atribuído (passo crítico), TODOS os
  // próximos passos não dependem entre si — rodam em PARALELO pra
  // cortar latência. Antes a tool fazia 3+ Kommo + 3+ Supabase em
  // série, gastando ~5-8s só esperando ida/volta de rede.
  const phoneQueries = [...new Set([telefone, formatTelefoneDigits(telefone), `+55${formatTelefoneDigits(telefone)}`])].filter(Boolean)
  const contactPatchPromise = kommoFetch(kommoBase, kommoToken, `/api/v4/contacts/${contactId}`, {
    method: 'PATCH',
    body: { responsible_user_id: consultorUserId },
  })
  const dadosClientePromise = (async () => {
    try {
      const enc = encodeURIComponent(telefone)
      await supabaseRest(mainUrl, mainKey, 'PATCH', `dados_cliente?telefone=eq.${enc}`, {
        atendimento_ia: 'pause',
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })()
  // Busca chat_messages pelas 3 variantes do telefone EM PARALELO,
  // pega a primeira não-vazia. Antes era loop sequencial.
  const messagesPromise = (async () => {
    const tasks = phoneQueries.map(async (q) => {
      try {
        const enc = encodeURIComponent(q)
        const rowsMsg = await supabaseRest(
          mainUrl,
          mainKey,
          'GET',
          `chat_messages?phone=eq.${enc}&select=*&order=created_at.asc&limit=500`,
        )
        return Array.isArray(rowsMsg) ? rowsMsg : []
      } catch {
        return []
      }
    })
    const results = await Promise.all(tasks)
    return results.find((r) => r.length > 0) || []
  })()

  const [contactPatch, dadosClienteRes, messages] = await Promise.all([
    contactPatchPromise,
    dadosClientePromise,
    messagesPromise,
  ])
  steps.push({ step: 'kommo_assign_contact', ok: contactPatch.ok, status: contactPatch.status })
  if (!contactPatch.ok) warnings.push(`kommo_assign_contact: ${contactPatch.text.slice(0, 200)}`)
  steps.push({ step: 'supabase_dados_cliente_pause', ok: dadosClienteRes.ok })
  if (!dadosClienteRes.ok) warnings.push(`dados_cliente: ${dadosClienteRes.error}`)
  steps.push({ step: 'supabase_chat_messages', ok: true, count: messages.length })

  const conversation = buildConversationFromMessages(messages)

  let summaryText = ''
  let parsed
  /** @type {{ model: string, usage: object }|null} */
  let summaryUsageInfo = null
  if (conversation.trim()) {
    try {
      const r = await openaiDistribuirResumo(env, openaiKey, conversation)
      summaryText = r.content
      summaryUsageInfo = { model: r.model, usage: r.usage }
      parsed = parseResumoCamposDistribuicao(summaryText)
      steps.push({ step: 'openai_resumo', ok: true, model: r.model })
    } catch (e) {
      warnings.push(`openai: ${e.message}`)
      steps.push({ step: 'openai_resumo', ok: false })
      parsed = parseResumoCamposDistribuicao('')
    }
  } else {
    warnings.push('Sem mensagens em chat_messages para resumir.')
    parsed = parseResumoCamposDistribuicao('')
  }

  // Pós-processamento totalmente paralelo: nota com resumo, mover pro
  // funil final e gravar a distribuição na tabela. As 3 operações são
  // independentes — rodavam em série antes (custo: 3-5s).
  const resumoNote = parsed.resumo || summaryText || 'Sem resumo automático.'
  const cursoVal = parsed.curso || 'Não informado'
  const nivelVal = parsed.nivel || 'Não informado'
  const telefoneFormatado = formatTelefoneDigits(telefone)
  const ts = new Date().toISOString()

  const notePromise = kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}/notes`, {
    method: 'POST',
    body: [{ note_type: 'common', params: { text: resumoNote } }],
  })

  const finalPatchPromise = kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}`, {
    method: 'PATCH',
    body: {
      pipeline_id: finalPipelineId,
      status_id: finalStatusId,
      custom_fields_values: [
        { field_id: KOMMO_FIELD_CURSO, values: [{ value: cursoVal }] },
        { field_id: KOMMO_FIELD_NIVEL, values: [{ value: nivelVal }] },
      ],
    },
  })

  const distribuicaoPromise = (async () => {
    const rowDistribuicao = {
      id_lead: idLead,
      consultor: consultorNome,
      timestamp: ts,
      origem: 'whatsapp',
      id_consultor: consultorUserId,
      telefone: telefoneFormatado,
    }
    try {
      await supabaseRest(
        mainUrl,
        mainKey,
        'POST',
        'distribuicao_por_consultor',
        [rowDistribuicao],
        'resolution=merge-duplicates',
      )
      return { ok: true }
    } catch (e) {
      if (String(e.message).includes('409')) {
        try {
          await supabaseRest(
            mainUrl,
            mainKey,
            'PATCH',
            `distribuicao_por_consultor?id_lead=eq.${idLead}`,
            {
              consultor: consultorNome,
              timestamp: ts,
              origem: 'whatsapp',
              id_consultor: consultorUserId,
              telefone: telefoneFormatado,
            },
          )
          return { ok: true, via: 'patch_id_lead' }
        } catch (e2) {
          return { ok: false, error: e2.message }
        }
      }
      return { ok: false, error: e.message }
    }
  })()

  const salesbotPromise = runKommoSalesbot(env, idLead, motivoFluxo)

  const [noteRes, finalPatch, distribuicaoRes, salesbotRes] = await Promise.all([
    notePromise,
    finalPatchPromise,
    distribuicaoPromise,
    salesbotPromise,
  ])
  steps.push({ step: 'kommo_note', ok: noteRes.ok, status: noteRes.status })
  if (!noteRes.ok) warnings.push(`kommo_note: ${noteRes.text.slice(0, 200)}`)
  steps.push({ step: 'kommo_final_lead', ok: finalPatch.ok, status: finalPatch.status })
  if (!finalPatch.ok) warnings.push(`kommo_final_lead: ${finalPatch.text.slice(0, 300)}`)
  steps.push({ step: 'supabase_distribuicao', ok: distribuicaoRes.ok, via: distribuicaoRes.via })
  if (!distribuicaoRes.ok) warnings.push(`distribuicao_por_consultor: ${distribuicaoRes.error}`)
  steps.push({
    step: 'kommo_salesbot',
    ok: salesbotRes.ok,
    status: salesbotRes.status,
    bot_id: salesbotRes.botId,
    motivo: salesbotRes.motivo || motivoFluxo,
    skipped: salesbotRes.skipped || false,
  })
  if (!salesbotRes.ok && !salesbotRes.skipped) {
    warnings.push(`kommo_salesbot: ${(salesbotRes.text || '').slice(0, 200)}`)
  }

  const retornoMatricula = normalizeSalesbotMotivo(motivoFluxo) === 'matricula_pos_form'
  return {
    ok: true,
    handoff_mode: 'full',
    retorno: retornoMatricula
      ? 'lead encaminhado após Form Sumar (salesbot pós-formulário disparado)'
      : 'atendimento distribuido para consultor',
    id_lead: idLead,
    consultor: consultorNome,
    id_consultor: consultorUserId,
    resumo_campos: parsed,
    texto_resumo_ia: summaryText,
    warnings,
    steps,
    _meta: summaryUsageInfo
      ? { toolUsage: [{ tool: 'distribuir_humano', model: summaryUsageInfo.model, usage: summaryUsageInfo.usage }] }
      : undefined,
  }
}

export function formatDistribuirHumanoReply(result) {
  if (!result.ok) {
    if (result.code === 'MISSING_CRM_FIELDS') {
      return result.message || 'Informe o telefone do lead para distribuir o atendimento humano.'
    }
    if (result.code === 'KOMMO_LEAD_NOT_FOUND') {
      return result.message || 'Lead não localizado no CRM. Peça pra ele entrar em contato pelo canal padrão.'
    }
    // Mensagem genérica pro LLM (sem citar funil/pipeline/IDs ao cliente).
    if (result.code === 'LEAD_NOT_ELIGIBLE') {
      return [
        'Não foi possível encaminhar para um consultor humano agora.',
        'INSTRUÇÃO: continue ajudando o cliente normalmente e diga que um consultor entrará em contato em breve. Não cite funil, pipeline ou detalhes técnicos.',
      ].join('\n')
    }
    if (result.code === 'DIST_COMERCIAL_NOT_CONFIGURED') {
      return [
        'Distribuição indisponível por configuração interna.',
        'INSTRUÇÃO: peça desculpas brevemente e diga que um consultor entrará em contato em breve.',
      ].join('\n')
    }
    return [
      'Distribuição não executada.',
      'INSTRUÇÃO: continue a conversa normalmente e diga que um consultor entrará em contato em breve. Não cite detalhes técnicos.',
    ].join('\n')
  }
  const lines = [
    result.retorno || 'Distribuição concluída.',
    result.consultor ? `Consultor designado: ${result.consultor}` : null,
  ].filter(Boolean)
  if (result.resumo_campos?.resumo) lines.push(`Resumo: ${result.resumo_campos.resumo}`)
  // Não devolver `id_consultor` (Kommo user id) pra o LLM — não tem
  // serventia pro cliente e atrapalha a resposta.
  return lines.join('\n')
}
