import { rewriteSearchQuery } from './queryRewrite'
import { runKnowledgeSearchPlayground } from './knowledgeSearchClient.js'

const BASE_URL = '/api/supabase'
const EMBEDDING_MODEL = 'text-embedding-3-small'

async function getEmbedding(text, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Embedding HTTP ${res.status}`)
  }
  const data = await res.json()
  return {
    embedding: data.data[0].embedding,
    usage: data.usage || null,
    model: EMBEDDING_MODEL,
  }
}

/**
 * Busca vetorial no Supabase. Espelha `server/ai/toolExecutorsServer.vectorSearch`:
 *   1. (opcional) reescreve a query com `gpt-4.1-nano`.
 *   2. gera embedding (`text-embedding-3-small`) da query final.
 *   3. chama o RPC `match_documents_*`.
 *
 * `traceCollector` (opcional) recebe metadados pra a aba "Execuções"
 * mostrar o que a reescrita fez e pra o Playground contabilizar custo
 * de tudo no `aiMeta`:
 *   {
 *     queryRewrite: { applied, query, originalQuery, model, usage, reason, elapsedMs },
 *     embeddingsUsage: { model, usage },
 *   }
 */
async function vectorSearch(rpcName, query, apiKey, matchCount = 10, opts = {}) {
  const traceCollector = opts.traceCollector || null
  const toolName = opts.toolName || rpcName

  // Etapa 1 — reescrita conservadora (com fallback p/ a query original).
  const rw = await rewriteSearchQuery({
    rawQuery: query,
    toolName,
    apiKey,
    model: opts.rewriteModel || 'gpt-4.1-nano',
    enabled: opts.rewriteEnabled !== false,
  })
  if (traceCollector) traceCollector.queryRewrite = rw
  const finalQuery = rw.applied ? rw.query : query
  if (rw.applied) {
    console.log(`[Supabase] queryRewrite: "${query}" → "${finalQuery}"`)
  } else if (rw.reason && rw.reason !== 'disabled' && rw.reason !== 'noop') {
    console.log(`[Supabase] queryRewrite skip: ${rw.reason}`)
  }

  console.log(`[Supabase] Gerando embedding para: "${finalQuery}"`)
  const emb = await getEmbedding(finalQuery, apiKey)
  if (traceCollector && emb.usage) {
    traceCollector.embeddingsUsage = { model: emb.model, usage: emb.usage }
  }
  console.log(`[Supabase] Embedding OK (${emb.embedding.length} dims), chamando RPC ${rpcName}...`)

  const url = `${BASE_URL}/rest/v1/rpc/${rpcName}`
  console.log(`[Supabase] POST ${url}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query_embedding: emb.embedding,
      filter: {},
      match_count: matchCount,
    }),
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    console.error(`[Supabase] ERRO ${res.status}:`, errBody)
    throw new Error(`Supabase ${res.status}: ${errBody.substring(0, 200)}`)
  }

  const data = await res.json()
  console.log(`[Supabase] ${rpcName} retornou ${data.length} resultados`)

  if (!Array.isArray(data) || data.length === 0) {
    return 'Nenhum resultado encontrado na base.'
  }
  return data.map((d) => d.content).join('\n\n---\n\n')
}

export async function buscarConhecimento(query, apiKey, traceCollector) {
  return runKnowledgeSearchPlayground(query, apiKey, traceCollector, { toolName: 'buscar_conhecimento' })
}

export async function buscarPrecos(query, apiKey, traceCollector) {
  return runKnowledgeSearchPlayground(query, apiKey, traceCollector, { toolName: 'buscar_precos', intentHint: 'preco' })
}

export async function buscarInformacoes(query, apiKey, traceCollector) {
  return runKnowledgeSearchPlayground(query, apiKey, traceCollector, {
    toolName: 'buscar_informacoes',
    levelHint: 'grad',
    intentHint: 'info',
  })
}

export async function buscarPos(query, apiKey, traceCollector) {
  return runKnowledgeSearchPlayground(query, apiKey, traceCollector, {
    toolName: 'buscar_pos',
    levelHint: 'pos',
    intentHint: 'info',
  })
}

export async function buscarPerguntas(query, apiKey, traceCollector) {
  return vectorSearch('match_documents_perguntas', query, apiKey, 6, { traceCollector, toolName: 'buscar_perguntas' })
}

/** Tool inscrição — Kommo + Supabase + resumo (servidor). telefone/id_lead opcionais até integração CRM. */
export async function executarInscricao(args) {
  const body = {
    curso: args.curso ?? args.Curso,
    tipo_ingresso: args.tipo_ingresso ?? args.tipoIngresso ?? args['Tipo de ingresso'],
    telefone: args.telefone,
    id_lead: args.id_lead ?? args.idLead,
  }
  const res = await fetch('/api/inscricao/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Resposta inválida da API de inscrição')
  }
  if (data.ok) {
    const lines = [
      data.retorno || 'Inscrição processada.',
      `Curso: ${data.curso}`,
      `Tipo de ingresso: ${data.tipo_ingresso}`,
    ]
    if (data.destino === 'aguardando_inscricao') lines.push('Destino no CRM: Aguardando Inscrição.')
    if (data.destino === 'atendimento') lines.push('Destino no CRM: atendimento (consultor).')
    if (data.missing_fields?.length) {
      lines.push(`Pendências na nota: ${data.missing_fields.join(', ')}`)
    }
    if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
    if (data.warnings?.length) lines.push(`Avisos: ${data.warnings.join(' | ')}`)
    return lines.join('\n')
  }
  if (data.code === 'MATRICULA_VIA_CONSULTOR' && data.message) return data.message
  if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
  if (data.code === 'MISSING_PARAMS') return data.error || 'Informe curso e tipo de ingresso (ENEM ou Vestibular Múltipla Escolha).'
  return `Inscrição não executada: ${data.error || data.message || data.code || `HTTP ${res.status}`}`
}

/** Tool memória — histórico da conversa em n8n_chat_histories (Supabase principal). */
export async function executarBuscarHistorico(args) {
  const res = await fetch('/api/memory/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telefone: args.telefone,
      limit: args.limit,
    }),
  })
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Resposta inválida da API de memória')
  }
  if (!data.ok) {
    if (data.code === 'MISSING_PARAMS') return data.error || 'Informe o telefone do lead para buscar o histórico.'
    return `Não foi possível recuperar o histórico: ${data.error || `HTTP ${res.status}`}`
  }
  return data.historico || 'Sem histórico de conversa disponível.'
}

/** Tool distribuir_humano — fila de consultor (Kommo + distrib_comercial + resumo). */
export async function executarDistribuirHumano(args) {
  const res = await fetch('/api/distribuir-humano/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id_lead: args.id_lead ?? args.idLead,
      telefone: args.telefone,
    }),
  })
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Resposta inválida da API de distribuição')
  }
  if (data.ok) {
    const lines = [
      data.retorno || 'Distribuição concluída.',
      data.consultor ? `Consultor designado: ${data.consultor}` : null,
    ].filter(Boolean)
    if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
    return lines.join('\n')
  }
  if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
  // Erros técnicos viram instrução genérica pro LLM — nunca expor
  // funil/pipeline/IDs internos pro cliente.
  if (data.code === 'LEAD_NOT_ELIGIBLE') {
    return [
      'Não foi possível encaminhar para um consultor humano agora.',
      'INSTRUÇÃO: continue ajudando o cliente normalmente e diga que um consultor entrará em contato em breve. Não cite funil, pipeline ou detalhes técnicos.',
    ].join('\n')
  }
  if (data.code === 'DIST_COMERCIAL_NOT_CONFIGURED') {
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

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'buscar_conhecimento',
      description:
        'Busca unificada na base vetorial da Faculdade Sumaré (graduação e pós: informações e preços). Use como primeira opção para dúvidas sobre curso, mensalidade, MBA, modalidade, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Pergunta ou termos de busca.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_precos',
      description:
        'Busca preços na base vetorial da Faculdade Sumaré (grad_preco / pos_preco). Use quando o foco for mensalidade/valor.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Nome limpo do curso para buscar preços (ex: "Administração", "Psicologia", "Recursos Humanos")',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_informacoes',
      description:
        'Busca informações de GRADUAÇÃO na base vetorial da Faculdade Sumaré (grad_info). Prefira buscar_conhecimento se o nível não estiver claro.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Nome limpo do curso de graduação (ex: "Psicologia", "Administração")',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_pos',
      description:
        'Busca informações de PÓS-GRADUAÇÃO na base vetorial da Faculdade Sumaré (pos_info). Prefira buscar_conhecimento se o nível não estiver claro.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Nome limpo do curso de pós-graduação (ex: "Marketing Digital", "Gestão de Pessoas")',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_perguntas',
      description: 'Busca respostas para perguntas frequentes (FAQ) na base vetorial. Use para dúvidas sobre matrícula, documentos, funcionamento, bolsas, processos, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A pergunta do usuário (ex: "como funciona o EAD", "documentos para matrícula")',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inscricao',
      description:
        'Inscrição automática no Kommo (só com INSCRICAO_AUTOMATICA_ENABLED=true no servidor). Fase atual: NÃO USE — colete curso + tipo de ingresso e chame distribuir_humano para o consultor finalizar a matrícula.',
      parameters: {
        type: 'object',
        properties: {
          curso: {
            type: 'string',
            description: 'Nome completo do curso confirmado pelo lead (ex.: "Desenvolvimento Backend").',
          },
          tipo_ingresso: {
            type: 'string',
            enum: ['ENEM', 'Vestibular Múltipla Escolha'],
            description: 'Prova de ingresso: ENEM ou Vestibular Múltipla Escolha.',
          },
          telefone: {
            type: 'string',
            description: 'Telefone do lead (Contexto do atendimento).',
          },
          id_lead: {
            type: 'integer',
            description: 'OPCIONAL — id_lead do Kommo se já estiver no Contexto. OMITA se não souber.',
          },
        },
        required: ['curso', 'tipo_ingresso', 'telefone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_historico_conversa',
      description:
        'Recupera o histórico recente de conversa com o lead no WhatsApp (memória do agente, tabela n8n_chat_histories). ' +
        'Use SEMPRE que o telefone do lead estiver disponível no contexto e você ainda não conhecer a conversa anterior — ' +
        'chame UMA vez no início do turno para entender o que já foi tratado antes de responder. ' +
        'A chave (session_id) é o telefone em dígitos + "@s.whatsapp.net" e é montada automaticamente a partir do parâmetro telefone.',
      parameters: {
        type: 'object',
        properties: {
          telefone: {
            type: 'string',
            description: 'Telefone do lead (ex.: "5511998209798") ou o session_id completo (ex.: "5511998209798@s.whatsapp.net").',
          },
          limit: {
            type: 'integer',
            description: 'Quantas mensagens recuperar (padrão 20, máx 100). Use 8–20 para entender o contexto recente.',
          },
        },
        required: ['telefone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'distribuir_humano',
      description:
        'Encaminha o lead para consultor humano e dispara salesbot no Kommo. motivo consultor (49777): dúvida/humano/FAQ. motivo matricula (49813): após curso + tipo de ingresso. id_lead opcional.',
      parameters: {
        type: 'object',
        properties: {
          telefone: {
            type: 'string',
            description: 'Telefone/WhatsApp do lead (obrigatório). Pode ser só dígitos ou com +55.',
          },
          id_lead: {
            type: 'integer',
            description: 'ID do lead no Kommo. OPCIONAL — se você não souber, omita este campo (NÃO mande 0 nem inventado).',
          },
          motivo: {
            type: 'string',
            enum: ['consultor', 'matricula'],
            description: 'consultor = dúvida/caso humano; matricula = finalizar inscrição após coletar curso e ingresso.',
          },
        },
        required: ['telefone'],
      },
    },
  },
]

export const TOOL_EXECUTORS = {
  buscar_conhecimento: (args, apiKey, traceCollector) => buscarConhecimento(args.query, apiKey, traceCollector),
  buscar_precos: (args, apiKey, traceCollector) => buscarPrecos(args.query, apiKey, traceCollector),
  buscar_informacoes: (args, apiKey, traceCollector) => buscarInformacoes(args.query, apiKey, traceCollector),
  buscar_pos: (args, apiKey, traceCollector) => buscarPos(args.query, apiKey, traceCollector),
  buscar_perguntas: (args, apiKey, traceCollector) => buscarPerguntas(args.query, apiKey, traceCollector),
  inscricao: (args) => executarInscricao(args),
  distribuir_humano: (args) => executarDistribuirHumano(args),
  buscar_historico_conversa: (args) => executarBuscarHistorico(args),
}
