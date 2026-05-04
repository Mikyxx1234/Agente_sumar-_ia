/**
 * Salesbot — Pesquisa de Curso (espelha o fluxo n8n "robocsv").
 *
 * Disparado por webhook do amocrm/Kommo (POST application/x-www-form-urlencoded
 * com `leads[add][0][id]`). O fluxo:
 *
 *  1. GET /api/v4/leads/{id} no Kommo — extrai os custom_fields_values.
 *  2. Acha os campos "Curso" e "Grau_new" no lead.
 *  3. Chama um LLM pequeno (gpt-4.1-mini) com instruções pra normalizar
 *     o nome do curso (Title Case, expansão de RH/TI/ADM, correções
 *     gramaticais), com acesso a uma "tool" de busca vetorial em
 *     `cursos_salesbot_nome` (RPC match_cursos_salesbot_nome).
 *  4. Normaliza o output (lowercase, sem acentos, sem prefixos tipo
 *     "Curso de", "Graduação em", "EAD").
 *  5. SQL no Supabase em `cursos_salesbot` filtrando por `curso_sinonimo`
 *     e `Curso` (LIKE/ILIKE como o original).
 *  6. PATCH no lead com 14 campos quando encontra; ou só o "Curso" =
 *     "Não Encontrado" caso contrário.
 *
 * Não tem custom field IDs hardcoded — a maioria já estava no fluxo do
 * n8n e a gente espelha aqui (eduitcombr.kommo.com). Pra outras
 * instâncias, sobrescrever via env (SALESBOT_FIELD_*_ID).
 */

import { resolveModel } from '../ai/modelRegistry.js'
import { listLeadCustomFields } from '../kommoClient.js'

// IDs dos custom fields do Kommo (Cruzeiro do Sul). Override via env
// se algum dia trocarem.
const F = {
  CURSO: 31782,
  GRAU_SITE_1: 690911,
  GRAU_SITE_2: 690913,
  MODALIDADE: 690923,
  MODALIDADE2: 690925,
  SEMESTRES: 690917,
  SEMESTRES_2: 690919,
  SEMESTRES_3: 690921,
  PRECO_1: 690929,
  PRECO_2: 690931,
  PRECO_3: 690933,
  CONTAGEM: 690937,
  TIPO_1: 693631,
  TIPO_2: 693633,
}

function envFieldId(env, key, fallback) {
  const fromEnv = Number(env?.[`SALESBOT_FIELD_${key}_ID`])
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : fallback
}

function nowIso() {
  return new Date().toISOString()
}

function generateExecutionId() {
  const d = new Date()
  const date = d.toISOString().slice(2, 10).replace(/-/g, '')
  const time = d.toISOString().slice(11, 16).replace(':', '')
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')
  return `SB-${date}-${time}-${rand}`
}

async function kommoFetch(env, path, { method = 'GET', body } = {}) {
  const base = String(env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = env.KOMMO_ACCESS_TOKEN || ''
  if (!base || !token) throw new Error('KOMMO_BASE_URL / KOMMO_ACCESS_TOKEN não configurados')
  const res = await fetch(`${base}${path}`, {
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

async function supabaseRest(url, key, method, pathAndQuery, body) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  }
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    headers.Prefer = 'return=representation'
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
 * Extrai value de um custom_field do lead Kommo, primeiro tentando por
 * field_name (compat com o fluxo n8n original), depois por field_id
 * usando o snapshot dos custom fields (mais robusto).
 */
function pickCustomFieldValue(lead, fieldNameAliases, fieldId, fieldsByName) {
  const list = Array.isArray(lead?.custom_fields_values) ? lead.custom_fields_values : []
  // Tentativa 1: por field_name (case-insensitive).
  for (const f of list) {
    const fn = String(f?.field_name || '').toLowerCase().trim()
    if (fieldNameAliases.some((a) => a.toLowerCase().trim() === fn)) {
      return f?.values?.[0]?.value || null
    }
  }
  // Tentativa 2: por field_id direto.
  if (Number.isFinite(fieldId)) {
    for (const f of list) {
      if (Number(f?.field_id) === fieldId) {
        return f?.values?.[0]?.value || null
      }
    }
  }
  // Tentativa 3: descobrir o ID pelo nome via API e tentar de novo.
  if (fieldsByName) {
    for (const a of fieldNameAliases) {
      const def = fieldsByName.get(String(a).toLowerCase().trim())
      if (def) {
        for (const f of list) {
          if (Number(f?.field_id) === def.id) return f?.values?.[0]?.value || null
        }
      }
    }
  }
  return null
}

/**
 * Roteamento por nível: "graduacao" | "pos".
 *
 * Heurística pra inferir do campo `Grau_new` do lead. Se o campo não
 * existir ou ficar ambíguo, default = graduacao (preserva comportamento
 * anterior do robocsv original).
 */
function inferNivel(grauStr) {
  const s = String(grauStr || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
  if (!s) return 'graduacao'
  // padrões de pós:
  if (/(pos|p[oó]s|mba|especializa|mestrado|doutorado|latu|stricto|stricto-sensu|lato-sensu)/.test(s)) {
    return 'pos'
  }
  return 'graduacao'
}

/**
 * Tabelas e RPCs por nível.
 *
 * Graduação tem duas tabelas (cursos_salesbot pra dados + cursos_salesbot_nome
 * pra busca vetorial). Pós usa UMA tabela só: cursos_salesbot_pos_nome —
 * o nome do curso fica em `content` e o resto (modalidade, duração, preço)
 * fica no `metadata` jsonb. Veja server/salesbot/SCHEMA_POS.sql.
 */
const NIVEL_TABLES = {
  graduacao: {
    catalog: 'cursos_salesbot',
    rpc: 'match_cursos_salesbot_nome',
  },
  pos: {
    catalog: 'cursos_salesbot_pos_nome',
    rpc: 'match_cursos_salesbot_pos_nome',
  },
}

/**
 * Vector search nas tabelas vetoriais do salesbot. Espelha a "tool"
 * "Buscar Cursos" do n8n original — única diferença é que escolhe a
 * tabela certa pelo nível inferido (`graduacao` ou `pos`).
 */
async function buscarCursosTool(env, query, nivel = 'graduacao') {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  const supaUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const supaKey = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!apiKey || !supaUrl || !supaKey) {
    return 'Tool indisponível (config faltando).'
  }
  const tables = NIVEL_TABLES[nivel] || NIVEL_TABLES.graduacao
  const embModel = resolveModel(env, 'embeddings')
  const embRes = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: embModel, input: String(query || '') }),
  })
  if (!embRes.ok) {
    const t = await embRes.text().catch(() => '')
    throw new Error(`Embedding ${embRes.status}: ${t.slice(0, 200)}`)
  }
  const embData = await embRes.json()
  const embedding = embData.data?.[0]?.embedding
  if (!embedding) return 'Sem embedding'

  const usageEmb = embData.usage || null

  // Pra pós, top 3 ajuda o agente a ver mais opções (ex: "RH" puro
  // pode mostrar "Gestão de RH", "Administração de RH" etc.). Pra
  // graduação mantém top 2 (comportamento histórico).
  const matchCount = nivel === 'pos' ? 3 : 2
  const rpcRes = await fetch(`${supaUrl.replace(/\/$/, '')}/rest/v1/rpc/${tables.rpc}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supaKey, Authorization: `Bearer ${supaKey}` },
    body: JSON.stringify({ query_embedding: embedding, match_count: matchCount }),
  })
  if (!rpcRes.ok) {
    const t = await rpcRes.text().catch(() => '')
    throw new Error(`RPC ${rpcRes.status}: ${t.slice(0, 200)}`)
  }
  const rows = await rpcRes.json()
  const list = Array.isArray(rows) ? rows : []
  const text = list.length === 0
    ? 'Nenhum resultado.'
    : list.map((r, i) => `${i + 1}. ${r.content || JSON.stringify(r)}`).join('\n')
  return { text, usage: usageEmb, embModel }
}

// Prompt original do n8n robocsv — usado pra GRADUAÇÃO (que já estava
// funcionando). Não mexer aqui sem testar todos os cursos.
const AGENT_SYSTEM_PROMPT_GRAD = (curso) =>
  `Utilize a tool 'buscar_cursos' para achar o curso: ${curso}\n` +
  `\n` +
  `Se estiver abreviado (ex: RH, TI, ADM), expanda para o nome completo no output.\n` +
  `Se tiver erro gramatical, corrija.\n` +
  `Se estiver correto, mantenha como está.\n` +
  `\n` +
  `No output, aplique Title Case (primeira letra de cada palavra em maiúscula), exceto as palavras "de", "em" e "da", que devem estar sempre em minúsculas (a menos que sejam a primeira palavra do nome).\n` +
  `\n` +
  `Retorne APENAS o nome do curso corrigido, sem explicações ou demais informações. Somente o curso encontrado na TOOL. Não retorne mais nada fora isso.\n` +
  `\n` +
  `Retorne somente o nome do curso, sem "-" ou a modalidade junto.`

// Prompt de PÓS — proíbe explicitamente substituir o input por outro
// curso só porque ele apareceu na tool (caso "Gestão de Recursos
// Humanos" virando "Gestão de Contratos").
const AGENT_SYSTEM_PROMPT_POS = (curso) =>
  `Você normaliza nomes de cursos de PÓS-GRADUAÇÃO para uma base de dados.\n` +
  `\n` +
  `Curso recebido: "${curso}"\n` +
  `\n` +
  `REGRAS (em ordem de prioridade):\n` +
  `\n` +
  `1) ABREVIAÇÕES — expanda quando óbvio:\n` +
  `   • RH → "Recursos Humanos"\n` +
  `   • TI → "Tecnologia da Informação"\n` +
  `   • ADM → "Administração"\n` +
  `   • MBA → mantenha "MBA" + área se tiver\n` +
  `\n` +
  `2) ⚠ NÃO SUBSTITUA O NOME DO CURSO POR OUTRO. A tool retorna os ` +
  `cursos mais SEMELHANTES da base — eles são apenas REFERÊNCIA pra ` +
  `você confirmar a grafia oficial. Se a tool não retornou o curso ` +
  `que o usuário pediu, MANTENHA o nome do usuário (não invente nem ` +
  `escolha um curso aleatório dos resultados).\n` +
  `   Exemplo: input "Gestão de Recursos Humanos", tool retorna ` +
  `"Gestão de Investimentos" e "Gestão de Contratos" — você DEVE ` +
  `responder "Gestão de Recursos Humanos" (o input original), NÃO um ` +
  `dos resultados da tool.\n` +
  `\n` +
  `3) Use a tool 'buscar_cursos' UMA vez para confirmar a grafia. Se ` +
  `algum resultado da tool for IDÊNTICO (ignorando case/acento) ao ` +
  `input, use a grafia oficial da tool. Caso contrário, use o input.\n` +
  `\n` +
  `4) Se houver erro gramatical claro (ex: "Administracao" sem cedilha, ` +
  `"saude publica" sem acento), corrija a ortografia mantendo o sentido.\n` +
  `\n` +
  `5) FORMATO: Title Case (primeira letra de cada palavra maiúscula), ` +
  `exceto "de", "em", "da", "do", "para", "com" — sempre minúsculos, ` +
  `salvo se forem a primeira palavra.\n` +
  `\n` +
  `6) NÃO inclua "EAD", "Curso de", "Graduação em", "Pós em", hífens ` +
  `nem modalidade. Só o nome do curso.\n` +
  `\n` +
  `OUTPUT: apenas o nome do curso normalizado, em uma linha, sem ` +
  `explicação ou comentário.`

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_cursos',
      description:
        'Pesquisa o curso na base vetorial (top resultados). Use para confirmar a grafia oficial do curso.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome do curso a pesquisar.' },
        },
        required: ['query'],
      },
    },
  },
]

async function runAgentCorrigeCurso(env, cursoBruto, nivel = 'graduacao') {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  const model = resolveModel(env, 'salesbot_curso')

  // Prompts diferentes por nível: graduação usa o original do n8n
  // (que já está em produção e funciona). Pós usa o reforçado pra
  // não substituir nomes válidos por cursos aleatórios.
  const systemPrompt = nivel === 'pos'
    ? AGENT_SYSTEM_PROMPT_POS(cursoBruto)
    : AGENT_SYSTEM_PROMPT_GRAD(cursoBruto)
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Corrija o nome deste curso se necessário: ${cursoBruto}` },
  ]
  const usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const embeddingsUsage = []
  const toolCalls = []

  for (let round = 0; round < 3; round += 1) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        tools: AGENT_TOOLS,
        temperature: 0.2,
        max_tokens: 200,
      }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`OpenAI ${res.status}: ${t.slice(0, 200)}`)
    }
    const data = await res.json()
    if (data.usage) {
      usageTotal.prompt_tokens += data.usage.prompt_tokens || 0
      usageTotal.completion_tokens += data.usage.completion_tokens || 0
      usageTotal.total_tokens += data.usage.total_tokens || 0
    }
    const choice = data.choices?.[0]
    const msg = choice?.message
    if (!msg) throw new Error('LLM sem resposta')

    if (msg.tool_calls?.length) {
      messages.push(msg)
      for (const tc of msg.tool_calls) {
        if (tc.function?.name !== 'buscar_cursos') {
          messages.push({ tool_call_id: tc.id, role: 'tool', content: 'Tool não disponível.' })
          continue
        }
        let args = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
        const result = await buscarCursosTool(env, args.query || cursoBruto, nivel).catch((e) => `Erro tool: ${e.message}`)
        const resultText = typeof result === 'string' ? result : (result?.text || '')
        if (typeof result === 'object' && result?.usage && result.embModel) {
          embeddingsUsage.push({ tool: 'salesbot.buscar_cursos', model: result.embModel, usage: result.usage })
        }
        toolCalls.push({ tool: 'buscar_cursos', args, result: resultText.slice(0, 1000) })
        messages.push({ tool_call_id: tc.id, role: 'tool', content: String(resultText) })
      }
      continue
    }

    return {
      content: String(msg.content || '').trim(),
      model,
      usage: usageTotal,
      embeddingsUsage,
      toolCalls,
    }
  }
  throw new Error('Limite de rodadas tool atingido (salesbot)')
}

/**
 * Normalização do output da IA (espelha "Code in JavaScript1" do n8n).
 */
function normalizeCursoBusca(output) {
  const raw = String(output || '').trim().toLowerCase()
  const cleaned = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\s*(curso de|graduacao em|graduacao de|tecnologo em|tecnologo de|bacharelado em|licenciatura em|gestao de)\s+/i, '')
    .replace(/\b(ead|semipresencial|presencial)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned
}

/**
 * Query SQL espelhando o "Execute a SQL query" do n8n.
 *
 * - Graduação: tabela `cursos_salesbot` com colunas dedicadas
 *   (curso_sinonimo, Curso, etc.). Mantém o critério ILIKE original.
 * - Pós: tabela `cursos_salesbot_pos_nome` com `content` (nome do curso)
 *   e `metadata` jsonb. Achatamos o jsonb num row pseudo-compatível pra
 *   reaproveitar `buildKommoCustomFieldsFromRowPos` sem mudança.
 */
/**
 * Faz a busca da linha do curso. Devolve:
 *   { row: object|null, top3?: Array, threshold?: number }
 *
 * row = linha "achatada" pronta pro buildKommoCustomFieldsFromRow
 * top3 (só pra pós) = top 3 candidatos do vector search com similarity
 *                     pra entender no debug por que algo não casou
 */
async function buscarLinhaCurso(env, cursoBusca, nivel = 'graduacao') {
  if (nivel === 'pos') return buscarLinhaCursoPos(env, cursoBusca)

  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL/KEY não configurados')

  const tableName = (NIVEL_TABLES[nivel] || NIVEL_TABLES.graduacao).catalog
  const enc = encodeURIComponent(cursoBusca)
  // Mantém os 3 critérios originais (espelham o n8n) + variantes mais
  // permissivas como fallback. PostgREST avalia em OR; o LIMIT 1 pega
  // a primeira linha que casar — então o critério mais específico
  // tende a ganhar quando há match exato.
  const orParts = [
    `curso_sinonimo.ilike.${enc}`,            // exato
    `Curso.ilike.${enc}`,                     // exato no Curso
    `curso_sinonimo.ilike.* ${enc} *`,        // contém com espaços ao redor (n8n original)
    `curso_sinonimo.ilike.*${enc}*`,          // contém em qualquer posição (cobre prefixos tipo "Gestão de")
    `Curso.ilike.*${enc}*`,                   // idem no Curso
  ].join(',')
  const path = `${tableName}?or=(${orParts})&select=*&limit=1`
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`)
  }
  try {
    const rows = JSON.parse(text)
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    return { row }
  } catch {
    return { row: null }
  }
}

/**
 * Pra pós: usa vector search (não ILIKE) porque o ILIKE do Postgres
 * é case-insensitive mas NÃO ignora acentos — o normalize tira acentos
 * ('saude publica') e nunca casa com 'Saúde Pública' no DB. Como já
 * temos embeddings gerados, vector search é mais barato (1 chamada à
 * RPC) e mais tolerante a grafias variantes.
 *
 * Threshold de 0.70: evita matches duvidosos. "Chutar é pior que
 * retornar Não Encontrado" — se a similarity é < 0.70 quase sempre
 * é uma das três coisas:
 *   (a) curso pedido não existe na base (ex: "MBA" sozinho — a
 *       pessoa precisa especificar a área),
 *   (b) o agente IA mandou um nome ruim ou incompleto,
 *   (c) é uma abreviação ambígua que mereceria intervenção humana.
 * Em qualquer um dos 3 casos, é melhor o humano cuidar do que
 * popular o lead com um curso aleatório.
 *
 * Matches genuínos (input bate com curso real da base) com
 * text-embedding-3-small em PT ficam em 0.80-0.97.
 *
 * Devolve null e o caller registra o resultado no debug — top_similarity
 * fica visível em steps pra entender o motivo do "Não Encontrado".
 */
const POS_MATCH_THRESHOLD = 0.70

async function buscarLinhaCursoPos(env, cursoBusca) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!apiKey || !url || !key) {
    throw new Error('OPENAI_API_KEY / SUPABASE_URL / SUPABASE_KEY não configurados')
  }
  const embModel = resolveModel(env, 'embeddings')
  const embRes = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: embModel, input: String(cursoBusca || '').trim() }),
  })
  if (!embRes.ok) {
    const t = await embRes.text().catch(() => '')
    throw new Error(`OpenAI embeddings ${embRes.status}: ${t.slice(0, 200)}`)
  }
  const embData = await embRes.json()
  const embedding = embData.data?.[0]?.embedding
  if (!embedding) return null

  const rpcRes = await fetch(`${url}/rest/v1/rpc/match_cursos_salesbot_pos_nome`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query_embedding: embedding, match_count: 3 }),
  })
  if (!rpcRes.ok) {
    const t = await rpcRes.text().catch(() => '')
    throw new Error(`Supabase RPC ${rpcRes.status}: ${t.slice(0, 200)}`)
  }
  const rows = await rpcRes.json()
  const list = Array.isArray(rows) ? rows : []
  const top = list[0] || null
  const sim = top && typeof top.similarity === 'number' ? top.similarity : 0

  // Resumo dos top 3 pra ficar visível no debug, com ou sem match.
  const top3 = list.slice(0, 3).map((r) => ({
    curso: r.metadata?.curso || r.content,
    similarity: typeof r.similarity === 'number' ? Number(r.similarity.toFixed(4)) : null,
  }))

  if (!top || sim < POS_MATCH_THRESHOLD) {
    return { row: null, top3, threshold: POS_MATCH_THRESHOLD }
  }

  const meta = top.metadata || {}
  return {
    row: {
      Curso: meta.curso || top.content,
      modalidade: meta.modalidade || 'EAD',
      duracao_1: meta.duracao_1 || null,
      preco_1: meta.preco_1 || null,
      duracao_2: meta.duracao_2 || null,
      preco_2: meta.preco_2 || null,
      contagem: meta.contagem || (meta.duracao_2 ? '2' : '1'),
      _similarity: Number(sim.toFixed(4)),
    },
    top3,
    threshold: POS_MATCH_THRESHOLD,
  }
}

/**
 * Lê um campo da linha do Supabase com tolerância a maiúsculas e nomes
 * com espaço (PostgREST devolve as colunas exatamente como criadas).
 */
function pickRowField(row, ...candidates) {
  if (!row) return null
  for (const c of candidates) {
    if (row[c] != null && String(row[c]).trim() !== '') return row[c]
  }
  return null
}

function buildKommoCustomFieldsFromRowGrad(env, row) {
  return [
    { field_id: envFieldId(env, 'CURSO', F.CURSO), values: [{ value: pickRowField(row, 'Curso', 'curso') || ' ' }] },
    { field_id: envFieldId(env, 'GRAU_SITE_1', F.GRAU_SITE_1), values: [{ value: pickRowField(row, 'Grau site 1', 'grau_site_1') || ' ' }] },
    { field_id: envFieldId(env, 'GRAU_SITE_2', F.GRAU_SITE_2), values: [{ value: pickRowField(row, 'Grau site 2', 'grau_site_2') || ' ' }] },
    { field_id: envFieldId(env, 'MODALIDADE', F.MODALIDADE), values: [{ value: pickRowField(row, 'modalidade', 'Modalidade') || ' ' }] },
    { field_id: envFieldId(env, 'MODALIDADE2', F.MODALIDADE2), values: [{ value: pickRowField(row, 'modalidade2', 'Modalidade2') || ' ' }] },
    { field_id: envFieldId(env, 'SEMESTRES', F.SEMESTRES), values: [{ value: pickRowField(row, 'Semestres', 'semestres') || ' ' }] },
    { field_id: envFieldId(env, 'SEMESTRES_2', F.SEMESTRES_2), values: [{ value: pickRowField(row, 'Semestres 2', 'semestres_2') || ' ' }] },
    { field_id: envFieldId(env, 'SEMESTRES_3', F.SEMESTRES_3), values: [{ value: pickRowField(row, 'Semestres 3', 'semestres_3') || ' ' }] },
    { field_id: envFieldId(env, 'PRECO_1', F.PRECO_1), values: [{ value: pickRowField(row, 'Preço eduit 1', 'preco_eduit_1') || ' ' }] },
    { field_id: envFieldId(env, 'PRECO_2', F.PRECO_2), values: [{ value: pickRowField(row, 'Preço eduit 2', 'preco_eduit_2') || ' ' }] },
    { field_id: envFieldId(env, 'PRECO_3', F.PRECO_3), values: [{ value: pickRowField(row, 'Preço eduit 3', 'preco_eduit_3') || ' ' }] },
    { field_id: envFieldId(env, 'CONTAGEM', F.CONTAGEM), values: [{ value: pickRowField(row, 'Contagem', 'contagem') || ' ' }] },
    { field_id: envFieldId(env, 'TIPO_1', F.TIPO_1), values: [{ value: pickRowField(row, 'Tipo 1', 'tipo_1') || ' ' }] },
    { field_id: envFieldId(env, 'TIPO_2', F.TIPO_2), values: [{ value: pickRowField(row, 'Tipo 2', 'tipo_2') || ' ' }] },
  ]
}

/**
 * Mapeia uma linha de `cursos_salesbot_pos` pros mesmos custom fields
 * do Kommo da graduação. O usuário pediu pra reaproveitar:
 *   "Semestres"    → duracao_1   (ex: "6 meses")
 *   "Semestres 2"  → duracao_2   (ex: "9 meses" ou vazio)
 *   "Preço eduit 1"→ preco_1
 *   "Preço eduit 2"→ preco_2
 *   "Modalidade"   → modalidade  (sempre "EAD")
 *   "Tipo 1/2"     → vazio       (pós não tem ENEM/Vestibular)
 *   "Grau site 1/2"→ "Pós-graduação"
 *
 * `Curso` recebe o nome do curso de pós já resolvido pelo agente.
 */
function buildKommoCustomFieldsFromRowPos(env, row) {
  const curso = pickRowField(row, 'Curso', 'curso') || ' '
  const modalidade = pickRowField(row, 'modalidade', 'Modalidade') || 'EAD'
  const duracao1 = pickRowField(row, 'duracao_1') || ' '
  const duracao2 = pickRowField(row, 'duracao_2') || ' '
  const preco1 = pickRowField(row, 'preco_1') || ' '
  const preco2 = pickRowField(row, 'preco_2') || ' '
  const contagem = pickRowField(row, 'contagem') || '2'
  return [
    { field_id: envFieldId(env, 'CURSO', F.CURSO), values: [{ value: curso }] },
    { field_id: envFieldId(env, 'GRAU_SITE_1', F.GRAU_SITE_1), values: [{ value: 'Pós-graduação' }] },
    { field_id: envFieldId(env, 'GRAU_SITE_2', F.GRAU_SITE_2), values: [{ value: 'Pós-graduação' }] },
    { field_id: envFieldId(env, 'MODALIDADE', F.MODALIDADE), values: [{ value: modalidade }] },
    { field_id: envFieldId(env, 'MODALIDADE2', F.MODALIDADE2), values: [{ value: modalidade }] },
    { field_id: envFieldId(env, 'SEMESTRES', F.SEMESTRES), values: [{ value: duracao1 }] },
    { field_id: envFieldId(env, 'SEMESTRES_2', F.SEMESTRES_2), values: [{ value: duracao2 }] },
    { field_id: envFieldId(env, 'SEMESTRES_3', F.SEMESTRES_3), values: [{ value: ' ' }] },
    { field_id: envFieldId(env, 'PRECO_1', F.PRECO_1), values: [{ value: preco1 }] },
    { field_id: envFieldId(env, 'PRECO_2', F.PRECO_2), values: [{ value: preco2 }] },
    { field_id: envFieldId(env, 'PRECO_3', F.PRECO_3), values: [{ value: ' ' }] },
    { field_id: envFieldId(env, 'CONTAGEM', F.CONTAGEM), values: [{ value: contagem }] },
    { field_id: envFieldId(env, 'TIPO_1', F.TIPO_1), values: [{ value: ' ' }] },
    { field_id: envFieldId(env, 'TIPO_2', F.TIPO_2), values: [{ value: ' ' }] },
  ]
}

function buildKommoCustomFieldsFromRow(env, row, nivel) {
  return nivel === 'pos'
    ? buildKommoCustomFieldsFromRowPos(env, row)
    : buildKommoCustomFieldsFromRowGrad(env, row)
}

/**
 * Roda o fluxo completo. Retorna um objeto serializável que cabe na
 * tabela `salesbot_execucoes`.
 *
 * @param {Record<string,string>} env
 * @param {{ leadId: number|string }} input
 */
export async function runSalesbotCsv(env, input) {
  const t0 = Date.now()
  const executionId = generateExecutionId()
  const leadIdNum = Number(input?.leadId)
  const steps = []
  const out = {
    executionId,
    leadId: Number.isFinite(leadIdNum) ? leadIdNum : null,
    timestamp: nowIso(),
    cursoOriginal: null,
    grauOriginal: null,
    nivel: 'graduacao',
    cursoCorrigido: null,
    cursoBusca: null,
    encontrado: false,
    rowCurso: null,
    model: null,
    usage: null,
    aiMeta: null,
    error: null,
    steps,
    durationMs: 0,
  }

  if (!Number.isFinite(leadIdNum) || leadIdNum <= 0) {
    out.error = 'leadId ausente ou inválido'
    out.durationMs = Date.now() - t0
    return out
  }

  try {
    // 1) GET lead.
    const leadRes = await kommoFetch(env, `/api/v4/leads/${leadIdNum}`)
    steps.push({ step: 'kommo_get_lead', ok: leadRes.ok, status: leadRes.status })
    if (!leadRes.ok) {
      out.error = `Kommo /leads/${leadIdNum} ${leadRes.status}: ${leadRes.text.slice(0, 200)}`
      out.durationMs = Date.now() - t0
      return out
    }
    let lead = null
    try { lead = JSON.parse(leadRes.text) } catch {}
    if (!lead) {
      out.error = 'Lead inválido (JSON parse)'
      out.durationMs = Date.now() - t0
      return out
    }

    // 2) Extrai Curso e Grau_new.
    const fieldsLookup = await listLeadCustomFields(env).catch(() => ({ ok: false }))
    const fieldsByName = fieldsLookup.ok ? fieldsLookup.byName : null

    const cursoBruto = pickCustomFieldValue(
      lead,
      ['Curso', 'curso'],
      envFieldId(env, 'CURSO', F.CURSO),
      fieldsByName,
    )
    const grauBruto = pickCustomFieldValue(
      lead,
      ['Grau_new', 'Grau new', 'Grau'],
      null,
      fieldsByName,
    )
    out.cursoOriginal = cursoBruto || null
    out.grauOriginal = grauBruto || null
    const nivel = inferNivel(grauBruto)
    out.nivel = nivel
    steps.push({ step: 'lead_fields', curso: cursoBruto, grau: grauBruto, nivel })

    if (!cursoBruto || !String(cursoBruto).trim()) {
      out.error = 'Lead não tem campo "Curso" preenchido — nada para pesquisar.'
      out.durationMs = Date.now() - t0
      return out
    }

    // 3) Agente IA corrige o nome (busca semântica na tabela do nível certo).
    const agent = await runAgentCorrigeCurso(env, String(cursoBruto), nivel)
    out.cursoCorrigido = agent.content
    out.model = agent.model
    out.usage = agent.usage
    out.aiMeta = {
      toolUsage: [],
      embeddingsUsage: agent.embeddingsUsage || [],
      queryRewriteUsage: [],
      toolCalls: agent.toolCalls,
    }
    steps.push({ step: 'ai_corrige_curso', model: agent.model, content: agent.content })

    // 4) Normalização para SQL.
    //
    // Graduação: aplica normalize (lowercase, sem acento, remove
    // prefixos tipo "Gestão de", "Curso de") porque a cursos_salesbot
    // tem coluna curso_sinonimo já normalizada — o ILIKE vai casar.
    //
    // Pós: NÃO normaliza. "Gestão de Recursos Humanos", "Gestão
    // Pública" etc são nomes completos no DB. Tirar "gestao de" da
    // query quebrava o vector search (similarity caía pra ~0.4).
    // Vector search já é tolerante a caso/acento/espaço.
    const cursoBusca = nivel === 'pos'
      ? String(agent.content || cursoBruto).trim()
      : normalizeCursoBusca(agent.content || cursoBruto)
    out.cursoBusca = cursoBusca
    steps.push({ step: 'normalize', cursoBusca })

    // 5) SQL/Vector search no Supabase (tabela do nível inferido).
    const search = await buscarLinhaCurso(env, cursoBusca, nivel)
    const row = search?.row || null
    out.rowCurso = row
    out.encontrado = !!row
    const sqlStep = {
      step: 'sql_query',
      tabela: (NIVEL_TABLES[nivel] || NIVEL_TABLES.graduacao).catalog,
      encontrado: out.encontrado,
      columns: row ? Object.keys(row).length : 0,
    }
    // Pra pós, sempre mostra os top 3 candidatos no debug — facilita
    // entender por que algo casou ou não.
    if (search?.top3) {
      sqlStep.top3 = search.top3
      sqlStep.threshold = search.threshold
    }
    steps.push(sqlStep)

    // 6) PATCH no lead.
    const customFields = out.encontrado
      ? buildKommoCustomFieldsFromRow(env, row, nivel)
      : [{ field_id: envFieldId(env, 'CURSO', F.CURSO), values: [{ value: 'Não Encontrado' }] }]

    const patchBody = {
      pipeline_id: Number(env.SALESBOT_PIPELINE_ID || 5481944),
      // status_id: 0 no n8n quer dizer "manter status atual" — não enviamos.
      custom_fields_values: customFields,
    }
    const patchRes = await kommoFetch(env, `/api/v4/leads/${leadIdNum}`, {
      method: 'PATCH',
      body: patchBody,
    })
    steps.push({ step: 'kommo_update_lead', ok: patchRes.ok, status: patchRes.status })
    if (!patchRes.ok) {
      out.error = `Kommo PATCH ${patchRes.status}: ${patchRes.text.slice(0, 300)}`
    }
  } catch (err) {
    out.error = err.message || String(err)
  }

  out.durationMs = Date.now() - t0
  return out
}

/**
 * Probe de busca de pós — usado pelo endpoint /api/salesbot/probe-pos
 * pra testar se a vector search está achando o curso certo, sem
 * efeito colateral no Kommo (não dispara agente, não PATCHa lead).
 *
 * @param {Record<string,string>} env
 * @param {{ query: string, topN?: number }} input
 */
export async function probePos(env, { query, topN = 3 } = {}) {
  const t0 = Date.now()
  const q = String(query || '').trim()
  if (!q) {
    return { ok: false, query: q, results: [], durationMs: 0, error: 'query vazia' }
  }
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  const supaUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const supaKey = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!apiKey || !supaUrl || !supaKey) {
    return {
      ok: false,
      query: q,
      results: [],
      durationMs: Date.now() - t0,
      error: 'config faltando (OPENAI_API_KEY/SUPABASE_URL/SUPABASE_KEY)',
    }
  }
  try {
    const embModel = resolveModel(env, 'embeddings')
    const embRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: embModel, input: q }),
    })
    if (!embRes.ok) {
      const t = await embRes.text().catch(() => '')
      throw new Error(`OpenAI embeddings ${embRes.status}: ${t.slice(0, 200)}`)
    }
    const embData = await embRes.json()
    const embedding = embData.data?.[0]?.embedding
    if (!embedding) throw new Error('OpenAI não devolveu embedding')

    const rpcRes = await fetch(
      `${supaUrl.replace(/\/$/, '')}/rest/v1/rpc/match_cursos_salesbot_pos_nome`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
        },
        body: JSON.stringify({
          query_embedding: embedding,
          match_count: Math.max(1, Math.min(10, topN)),
        }),
      },
    )
    if (!rpcRes.ok) {
      const t = await rpcRes.text().catch(() => '')
      throw new Error(`Supabase RPC ${rpcRes.status}: ${t.slice(0, 200)}`)
    }
    const rows = await rpcRes.json()
    const results = (Array.isArray(rows) ? rows : []).map((r) => {
      const m = r.metadata || {}
      return {
        curso: m.curso || r.content,
        modalidade: m.modalidade || 'EAD',
        duracao_1: m.duracao_1 || null,
        preco_1: m.preco_1 || null,
        duracao_2: m.duracao_2 || null,
        preco_2: m.preco_2 || null,
        contagem: m.contagem || null,
        similarity: typeof r.similarity === 'number' ? Number(r.similarity.toFixed(4)) : null,
      }
    })
    return {
      ok: true,
      query: q,
      embModel,
      results,
      durationMs: Date.now() - t0,
      usage: embData.usage || null,
    }
  } catch (err) {
    return {
      ok: false,
      query: q,
      results: [],
      durationMs: Date.now() - t0,
      error: err.message || String(err),
    }
  }
}

/**
 * Helper: parser do payload amocrm webhook.
 *
 * O amocrm manda como `application/x-www-form-urlencoded`, com chaves
 * em bracket notation (`leads[add][0][id]=12345`). Express com
 * `express.urlencoded({ extended: true })` já desserializa pra objeto
 * aninhado: `{ leads: { add: [{ id: '12345' }] } }`. Cobrimos os dois
 * formatos por garantia.
 */
export function extractLeadIdFromWebhookBody(body) {
  if (!body || typeof body !== 'object') return null
  // Express urlencoded com extended=true:
  const fromAdd = body?.leads?.add?.[0]?.id
  if (fromAdd != null) return Number(fromAdd) || null
  const fromUpdate = body?.leads?.update?.[0]?.id
  if (fromUpdate != null) return Number(fromUpdate) || null
  // Express com extended=false ou leitor cru: chaves bracket-string.
  for (const k of Object.keys(body)) {
    const m = /^leads\[(add|update)\]\[0\]\[id\]$/.exec(k)
    if (m) return Number(body[k]) || null
  }
  // JSON puro.
  if (body.id != null) return Number(body.id) || null
  if (body.lead_id != null) return Number(body.lead_id) || null
  if (body.leadId != null) return Number(body.leadId) || null
  return null
}
