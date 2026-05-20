/**
 * Schemas das tools (OpenAI function-calling) — espelha src/lib/supabaseSearch.js.
 * Mantenha em sincronia com o front ao alterar argumentos/descrições.
 */

import { isInscricaoAutomaticaEnabled } from '../inscricaoConfig.js'

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'buscar_conhecimento',
      description:
        'Busca unificada na base vetorial da Faculdade Sumaré (graduação e pós-graduação: informações gerais e preços). ' +
        'Use como PRIMEIRA opção para dúvidas sobre curso, mensalidade, modalidade, grade, MBA, especialização, etc. ' +
        'O sistema escolhe automaticamente as tabelas corretas (pos_info, pos_preco, grad_info, grad_preco).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Pergunta ou termos de busca (ex.: nome do curso + o que o lead quer saber).' },
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
        'Busca preços e valores na base vetorial da Faculdade Sumaré (tabelas pos_preco / grad_preco via RPC). ' +
        'Alternativa a buscar_conhecimento quando o foco for só mensalidade/valor.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome limpo do curso (ex: "Administração").' },
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
        'Busca informações de GRADUAÇÃO na base vetorial da Faculdade Sumaré (grad_info). Prefira buscar_conhecimento se não tiver certeza do nível.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome limpo do curso de graduação.' },
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
        'Busca informações de PÓS-GRADUAÇÃO na base da Faculdade Sumaré (pos_info). Prefira buscar_conhecimento se o nível não estiver claro.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome limpo do curso de pós-graduação.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_perguntas',
      description:
        'Busca respostas para perguntas frequentes (FAQ): matrícula, documentos, funcionamento, bolsas, processos, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Pergunta do usuário.' },
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
        'Inscrição automática no Kommo (só quando INSCRICAO_AUTOMATICA_ENABLED=true). Na fase atual NÃO USE — confirme o curso e dispare o fluxo Form Sumar (regra 7). Não peça ENEM/Vestibular ao lead.',
      parameters: {
        type: 'object',
        properties: {
          curso: {
            type: 'string',
            description: 'Nome completo do curso confirmado pelo lead (ex.: "Desenvolvimento Backend").',
          },
          tipo_ingresso: {
            type: 'string',
            description: 'OPCIONAL — não pergunte ao lead. Se omitido, o servidor usa valor padrão (Vestibular).',
          },
          telefone: { type: 'string', description: 'Telefone do lead (Contexto do atendimento).' },
          id_lead: {
            type: 'integer',
            description: 'OPCIONAL — id_lead do Kommo se já estiver no Contexto. OMITA se não souber.',
          },
        },
        required: ['curso', 'telefone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_historico_conversa',
      description:
        'Recupera histórico recente de conversa com o lead no WhatsApp (n8n_chat_histories). ' +
        'Use apenas se precisar de mais contexto além das últimas mensagens já injetadas.',
      parameters: {
        type: 'object',
        properties: {
          telefone: { type: 'string' },
          limit: { type: 'integer' },
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
        'Encaminha o lead para um consultor humano finalizar o atendimento. Use quando: (1) o lead pedir humano/atendente/consultor; ' +
        '(2) após coletar curso confirmado + tipo de ingresso (ENEM ou Vestibular Múltipla Escolha) para MATRÍCULA/INSCRIÇÃO — obrigatório nesse caso; ' +
        '(3) negociação, caso complexo, FAQ sem resposta ou fora do escopo da IA. ' +
        'O sistema localiza o lead pelo telefone automaticamente — você NÃO precisa passar id_lead se não souber.',
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
            description:
              'consultor = encaminhar dúvida/caso para humano (salesbot 49777). ' +
              'matricula = enviar template Form Sumar (NÃO dispara salesbot direto). Default: consultor.',
          },
        },
        required: ['telefone'],
      },
    },
  },
]

/** Tools expostas ao orquestrador — omite inscricao quando matrícula automática está desligada. */
export function getToolDefinitions(env = process.env) {
  if (isInscricaoAutomaticaEnabled(env)) return TOOL_DEFINITIONS
  return TOOL_DEFINITIONS.filter((t) => t.function?.name !== 'inscricao')
}
