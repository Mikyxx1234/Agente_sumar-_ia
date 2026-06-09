/**
 * Passo de CONFIRMAÇÃO antes do formulário/matrícula.
 *
 * Quando o lead confirma que quer se matricular num curso, em vez de já
 * disparar o formulário, o agente envia um resumo (curso, duração, mensalidade,
 * taxa de matrícula = primeira mensalidade, mesmo valor) e pede autorização:
 *
 *   "Você autoriza a conclusão da matrícula?"
 *
 * Só depois do "sim/autorizo" o fluxo existente envia o formulário (nada do
 * fluxo pós-formulário muda). Se o lead tiver dúvida/recusar, segue o
 * atendimento normal (o LLM responde) — consultor só se necessário.
 *
 * Gate determinístico (status `aguardando_autorizacao_matricula`):
 *   - status null + lead confirma matrícula + curso/preço resolvidos
 *       → grava status, envia o resumo (short-circuit), NÃO envia formulário.
 *   - status aguardando_autorizacao_matricula + lead autoriza
 *       → reseta status p/ null e devolve null (o fluxo existente envia o form).
 *   - status aguardando_autorizacao_matricula + dúvida/recusa
 *       → devolve null (LLM faz o atendimento normal); mantém o gate.
 *   - sem curso/preço resolvido → devolve null (degrada para o fluxo atual).
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_AUTORIZACAO,
  messageConfirmsProceedToInscricaoForm,
  messageAsksForFormResend,
  assistantAskedMatriculaAuthorization,
  lastAssistantText,
} from '../libShared/inscricaoFormHeuristics.js'
import { messageAsksCoursePrice } from '../libShared/inboundMessageSanitize.js'
import { detectCursoConfirmadoPeloLead } from '../libShared/cursoConfirmation.js'
import { extractDiscussedCourseFromHistory } from '../libShared/conversationContextHeuristics.js'
import {
  fetchDadosClienteByTelefone,
  updateDadosCliente,
  ensureDadosClienteRow,
} from './dadosClienteStore.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

async function getFormStatus(env, telefone) {
  const row = await fetchDadosClienteByTelefone(env, telefone, FORM_STATUS_FIELD)
  return row?.[FORM_STATUS_FIELD] ?? null
}

async function setFormStatus(env, telefone, status, leadIdHint) {
  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadIdHint,
    fields: { [FORM_STATUS_FIELD]: status },
  }).catch(() => {})
  return updateDadosCliente(env, { telefone, fields: { [FORM_STATUS_FIELD]: status } })
}

const STOPWORDS = new Set([
  'graduacao', 'pos', 'posgraduacao', 'curso', 'cursos', 'de', 'do', 'da', 'dos', 'das',
  'em', 'e', 'a', 'o', 'as', 'os', 'com', 'foco', 'bacharelado', 'licenciatura',
  'tecnologo', 'tecnologico', 'superior', 'ead', 'semipresencial', 'presencial',
  'mba', 'especializacao', 'pos-graduacao',
])

function normalizeForMatch(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function meaningfulTokens(s) {
  return normalizeForMatch(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

/** Parseia o `content` "k: v | k: v | ..." das tabelas de preço. */
function parsePrecoContent(content) {
  const map = {}
  for (const part of String(content || '').split('|')) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim().toLowerCase()
    const v = part.slice(idx + 1).trim()
    if (k) map[k] = v
  }
  return map
}

function formatMensalidade(raw) {
  const v = String(raw || '').trim()
  if (!v) return ''
  if (/^\d+$/.test(v)) return `R$ ${v},00`
  if (/^\d+[.,]\d{1,2}$/.test(v)) return `R$ ${v.replace('.', ',')}`
  return /r\$/i.test(v) ? v : `R$ ${v}`
}

async function fetchPrecoRows(env) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
  if (!url || !key) return []
  const headers = { apikey: key, Authorization: `Bearer ${key}` }
  const out = []
  for (const [table, nivel] of [
    ['grad_preco', 'graduação'],
    ['pos_preco', 'pós-graduação'],
  ]) {
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=id,content,metadata&limit=200`, { headers })
      if (!res.ok) continue
      const rows = await res.json()
      if (Array.isArray(rows)) for (const r of rows) out.push({ ...r, table, nivel })
    } catch {
      /* ignore */
    }
  }
  return out
}

/**
 * Busca o curso nas tabelas de preço pelo nome e devolve os dados do resumo.
 * @returns {Promise<{ cursoNome, nivel, mensalidade, duracao, modalidade }|null>}
 */
export async function lookupCursoPrecoResumo(env, cursoNome) {
  const targetTokens = meaningfulTokens(cursoNome)
  if (targetTokens.length === 0) return null
  const targetSet = new Set(targetTokens)

  const rows = await fetchPrecoRows(env)
  let best = null
  let bestScore = 0
  for (const row of rows) {
    const map = parsePrecoContent(row.content)
    const cand = map['chave'] || map['nome_curso'] || map['curso'] || ''
    const candSet = new Set(meaningfulTokens(cand))
    if (candSet.size === 0) continue
    let inter = 0
    for (const t of targetSet) if (candSet.has(t)) inter += 1
    const union = new Set([...targetSet, ...candSet]).size
    const score = union > 0 ? inter / union : 0
    if (score > bestScore) {
      bestScore = score
      best = { row, map }
    }
  }

  // Exige sobreposição mínima e ao menos 1 token em comum para evitar match errado.
  if (!best || bestScore < 0.5) return null

  const { row, map } = best
  const mensalidade = formatMensalidade(map['preco com desconto'])
  if (!mensalidade) return null
  const nomeCurso =
    map['nome_curso']?.replace(/^Gradua[cç][aã]o\s*[-–]\s*/i, '').trim() ||
    map['curso']?.replace(/^P[oó]s-?Gradua[cç][aã]o\s+(em\s+)?/i, '').trim() ||
    map['chave'] ||
    String(cursoNome).trim()
  const duracao = String(map['duracao'] || row.metadata?.duracao || '').trim()
  return {
    cursoNome: nomeCurso,
    nivel: row.nivel,
    mensalidade,
    duracao,
    modalidade: map['modalidade'] || row.metadata?.modalidade || '',
  }
}

export function buildMatriculaResumoReply({ cursoNome, duracao, mensalidade, pushName }) {
  const first = pushName ? String(pushName).split(/\s+/)[0] : ''
  const saud = first ? `Perfeito, ${first}! ` : 'Perfeito! '
  const linhaCurso = duracao
    ? `- Você irá ingressar no curso de "${cursoNome}" com duração de ${duracao.toLowerCase()}`
    : `- Você irá ingressar no curso de "${cursoNome}"`
  return [
    `${saud}Então, ficou assim:`,
    '',
    linhaCurso,
    `- Mensalidades: ${mensalidade}`,
    `- A taxa de matrícula é a primeira mensalidade, no valor de ${mensalidade}.`,
    '',
    'Você autoriza a conclusão da matrícula?',
  ].join('\n')
}

function buildAgentReturn({ executionId, model, t0, reply, steps, ctxSnapshot }) {
  return {
    ok: true,
    reply,
    toolCalls: [],
    orchestratorSteps: steps || [],
    ctxSnapshot: ctxSnapshot || {},
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    durationMs: Date.now() - t0,
    executionId,
    model,
    inscricaoFormHandled: true,
  }
}

/**
 * @returns {Promise<{ handled: boolean, result?: object }|null>}
 */
export async function tryHandleMatriculaResumoConfirmacao(env, ctx) {
  const { telefone, userMessage, executionId, model, leadId, pushName, t0 } = ctx
  const historyMessages = ctx.historyMessages || []
  if (!telefone || !String(userMessage || '').trim()) return null
  if (messageAsksForFormResend(userMessage)) return null
  if (messageAsksCoursePrice(userMessage)) return null

  const status = await getFormStatus(env, telefone)
  const wantsForm = messageConfirmsProceedToInscricaoForm(userMessage, historyMessages)

  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_AUTORIZACAO) {
    if (wantsForm) {
      // Autorizou → libera: reseta o gate e deixa o fluxo existente enviar o form.
      await setFormStatus(env, telefone, null, leadId)
      console.log(`[matriculaResumo] telefone=${telefone} AUTORIZADO — liberando envio do formulário`)
      return null
    }
    // Dúvida/recusa → atendimento normal (LLM). Mantém o gate p/ autorizar depois.
    return null
  }

  // Só intercepta quando ainda não há nenhum estágio de inscrição em curso.
  if (status != null) return null
  if (!wantsForm) return null
  if (assistantAskedMatriculaAuthorization(lastAssistantText(historyMessages))) return null

  let cursoNome =
    detectCursoConfirmadoPeloLead(userMessage, historyMessages) ||
    extractDiscussedCourseFromHistory(historyMessages) ||
    ''
  if (!cursoNome && leadId) {
    try {
      const snap = await fetchLeadFormSnapshot(env, leadId)
      cursoNome = String(snap?.snapshot?.curso_inscricao || '').trim()
    } catch {
      /* ignore */
    }
  }
  if (!cursoNome) return null

  const resumo = await lookupCursoPrecoResumo(env, cursoNome)
  if (!resumo) {
    console.log(`[matriculaResumo] telefone=${telefone} curso="${cursoNome}" sem preço resolvido — segue fluxo normal`)
    return null
  }

  await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_AUTORIZACAO, leadId)
  const reply = buildMatriculaResumoReply({ ...resumo, pushName })
  console.log(
    `[matriculaResumo] telefone=${telefone} RESUMO enviado curso="${resumo.cursoNome}" mensalidade="${resumo.mensalidade}" duracao="${resumo.duracao || 'n/a'}" nivel=${resumo.nivel}`,
  )
  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps: [
        {
          type: 'matricula_resumo_confirmacao',
          curso: resumo.cursoNome,
          mensalidade: resumo.mensalidade,
          duracao: resumo.duracao || null,
          nivel: resumo.nivel,
        },
      ],
      ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_AUTORIZACAO },
    }),
  }
}
