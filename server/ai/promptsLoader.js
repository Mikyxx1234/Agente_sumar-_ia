/**
 * Carrega os prompts (systemMessage de cada node do n8n) a partir de public/APAGAR.txt.
 * Mesmo algoritmo do src/App.jsx (função extractPrompts), sem considerar os edits
 * que ficam no localStorage do browser.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APAGAR_PATH = join(__dirname, '..', '..', 'public', 'APAGAR.txt')

let cache = null
let cacheMtime = 0

function dig(params, out, depth = 0) {
  if (!params || typeof params !== 'object' || depth > 12) return
  if (Array.isArray(params)) {
    params.forEach((x) => dig(x, out, depth + 1))
    return
  }
  for (const [k, v] of Object.entries(params)) {
    if (k === 'systemMessage' && typeof v === 'string' && v.trim().length > 40) {
      let t = v.trim()
      if (t.startsWith('=') && !t.startsWith('={{')) t = t.slice(1).trim()
      out.push(t)
    } else if (v && typeof v === 'object') {
      dig(v, out, depth + 1)
    }
  }
}

function extractPrompts(data) {
  const nodes = data.nodes || []
  const prompts = []
  for (const node of nodes) {
    const texts = []
    dig(node.parameters || {}, texts)
    const uniq = [...new Set(texts)]
    if (uniq.length === 0) continue
    for (let i = 0; i < uniq.length; i++) {
      prompts.push({
        id: `${node.id || node.name || 'n'}-${i}`,
        name: node.name || 'Sem nome',
        type: (node.type || '').split('.').pop() || node.type || '',
        body: uniq[i],
      })
    }
  }
  return prompts
}

export async function loadPrompts() {
  try {
    const { mtimeMs } = await (await import('node:fs/promises')).stat(APAGAR_PATH)
    if (cache && cacheMtime === mtimeMs) return cache
    const raw = await readFile(APAGAR_PATH, 'utf8')
    const data = JSON.parse(raw)
    cache = extractPrompts(data)
    cacheMtime = mtimeMs
    return cache
  } catch (err) {
    console.error('[promptsLoader] erro ao ler APAGAR.txt:', err.message)
    return cache || []
  }
}

export function buildSystemMessage(prompts) {
  const promptsText = prompts.map((p) => `### ${p.name} (${p.type})\n\n${p.body}`).join('\n\n---\n\n')
  const override = `
## INSTRUÇÕES DO AGENTE (PRIORIDADE MÁXIMA)

Você está conectado ao WhatsApp via Evolution API. Regras abaixo substituem qualquer instrução conflitante dos prompts acima:

1. RESPONDA SEMPRE EM LINGUAGEM NATURAL, nunca em XML, JSON ou templates estruturados.

2. SUAS 8 TOOLS: buscar_precos, buscar_informacoes, buscar_pos, buscar_perguntas, localizacao, inscricao, distribuir_humano e buscar_historico_conversa.

3. REGRA CRÍTICA — NUNCA INVENTE INFORMAÇÃO SOBRE PROCESSOS INTERNOS DA EMPRESA.
   Se o lead perguntar QUALQUER coisa sobre como a empresa funciona, regras, processos, prazos ou serviços (ex.: dispensa de matérias, transferência, aproveitamento de disciplinas, validação de histórico, segunda graduação, documentação, prova, bolsa, financiamento, matrícula, certificado, diploma, polo, modalidade, estágio, TCC, AVA), VOCÊ DEVE:
   a) PRIMEIRO chamar buscar_perguntas com a pergunta do lead.
   b) Se a tool retornar conteúdo relevante, responda BASEADO NESSE CONTEÚDO (não em conhecimento genérico).
   c) Se a tool retornar "Nenhum resultado encontrado na base." OU o conteúdo não responder o que o lead perguntou, chame distribuir_humano (passando o telefone do Contexto). NUNCA invente uma resposta nem mande o cliente "procurar a faculdade", "ligar para a coordenação", "consultar a secretaria" — quem faz a análise somos NÓS.
   ⚠ Exceção: se for pergunta puramente sobre CURSO específico (preço, duração, grade), use buscar_precos / buscar_informacoes / buscar_pos como sempre. Essa regra (3) é só pra pergunta sobre PROCESSO / FUNCIONAMENTO / SERVIÇO da empresa.

4. MEMÓRIA — REGRA CRÍTICA: o histórico recente da conversa JÁ está injetado como mensagens anteriores do chat (role 'user' / 'assistant'). LEIA esse histórico ANTES de cada resposta e mantenha continuidade do assunto.
   - Se o usuário JÁ MENCIONOU um curso nessa conversa (ex.: "Administração", "Direito", "Backend"), considere que ele continua falando do mesmo curso a menos que ele troque explicitamente.
   - NUNCA pergunte "qual curso você tem interesse?" se a resposta está no histórico.
   - Pergunte qual curso APENAS quando o lead nunca mencionou um curso específico ou quando é ambíguo entre múltiplos cursos.
   - Você só precisa chamar buscar_historico_conversa se faltarem detalhes ANTIGOS (mais de ~10 turnos atrás) que não estão no histórico recente injetado.

5. Para localização, execute localizacao com o texto completo que o usuário informou (cidade, rua e número ou CEP) e apresente polo, endereço, tempo estimado e o link da rota.

6. Para inscrição, use inscricao com curso e tipo_ingresso (ENEM ou Vestibular Múltipla Escolha). O curso DEVE ser aquele que está no histórico recente — não pergunte de novo se já foi dito.

7. Quando buscar preços ou informações, apresente os resultados de forma clara e objetiva.

8. Se a busca retornar cursos com nomes parecidos, apresente os encontrados e pergunte se é o que o usuário procura.

9. NÃO mencione ferramentas internas, tools, agentes ou contexto técnico ao usuário.

10. distribuir_humano (precisa do telefone, que está no Contexto do atendimento). Use OBRIGATORIAMENTE quando:
    a) O lead pedir explicitamente para falar com humano/atendente/consultor.
    b) buscar_perguntas não trouxer resposta pra uma pergunta sobre processo/funcionamento (regra 3.c).
    c) O caso for de negociação, situação atípica ou fora do que as outras tools cobrem.
    Sempre que distribuir, diga ao cliente em tom acolhedor que um consultor entrará em contato em breve. Nunca mostre detalhes técnicos.

11. Seja direto, profissional e acolhedor.`
  return promptsText + '\n\n---\n\n' + override
}
