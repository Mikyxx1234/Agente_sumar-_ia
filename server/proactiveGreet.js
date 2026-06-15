/**
 * Saudação proativa — o agente inicia a conversa quando o lead entra no Kommo
 * (formulário do site → workflow n8n criacao_leads_sumaread_kommo_v3), sem
 * esperar o lead falar primeiro.
 *
 * Usado em dois pontos (abordagem híbrida — ver AGENT.md 2026-06-15):
 *   1) Endpoint POST /api/leads/proactive-greet  → saudação instantânea (n8n).
 *   2) agentScheduler (ramo "buffer vazio")       → rede de segurança p/ leads
 *      da fila ainda sem atendimento (inclui backlog antigo).
 *
 * Idempotência (nunca saudar 2x):
 *   - coluna persistente `proactive_greet_at` (claim-exclusivo via PATCH
 *     ?...&proactive_greet_at=is.null — mesmo padrão do reengajamento);
 *   - dedupe em memória (sobrevive entre ticks do mesmo processo);
 *   - hasPriorAttendance (buffer, memória n8n, chat_messages c/ resposta do
 *     bot, nota do agente no Kommo);
 *   - dedupe de outbound do próprio sendMessageWithNote.
 *
 * Env:
 *   PROACTIVE_GREET_ENABLED=false   chave geral (default desligado)
 *   KOMMO_FIELD_SUM_NIVEL_ID=1475427  id do campo sum_Nivel (Graduação/Pós)
 */

import { getMessages } from './evolution/messageBuffer.js'
import { sendMessageWithNote } from './whatsappSender.js'
import {
  fetchRecentChatRows,
  saveConversation,
  appendChatMemory,
} from './historyStore.js'
import { runBuscarHistorico } from './memoryTool.js'
import { listLeadNotes, findLeadByPhone } from './kommoClient.js'
import { phoneToWhatsAppSessionId } from './phoneWhatsApp.js'
import { generateExecutionId } from './ai/executionTelemetry.js'
import {
  updateDadosCliente,
  fetchDadosClienteByTelefone,
  dadosClienteTelefoneOrFilter,
  normalizeTelefone,
} from './dadosClienteStore.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'

const FIELD_GREET_AT = 'proactive_greet_at'
const FORM_STATUS_FIELD = 'inscricao_form_status'
const DEFAULT_SUM_NIVEL_FIELD_ID = 1475427

/** Notas/falas que indicam que o agente já tocou nesse lead. */
const AGENT_NOTE_RE =
  /assistente|faculdade sumaré|sou o assistente|sou assistente|encaminhei seu atendimento|já encaminhei|bem-vindo|bem vindo|\s-\sEX-\d{6}/i

const SKIP_INSCRICAO_STATUSES = new Set([
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
])

/** Dedupe em memória se a coluna Supabase ainda não existir / claim falhar. */
const _greetMemory = new Map()
const GREET_MEMORY_TTL_MS = 24 * 60 * 60 * 1000

export function isProactiveGreetEnabled(env) {
  const flag = String(env.PROACTIVE_GREET_ENABLED ?? 'false').trim().toLowerCase()
  return !['false', '0', 'no', 'off', ''].includes(flag)
}

function getDadosClienteCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum',
  }
}

/** Primeiro nome, com capitalização básica. Ignora nomes vazios/telefones. */
function firstName(nome) {
  const raw = String(nome || '').trim()
  if (!raw) return ''
  const first = raw.split(/\s+/)[0]
  if (!first || /\d/.test(first) || first.length < 2) return ''
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

/** Normaliza o nível do lead em 'graduacao' | 'pos' | ''. */
function normalizeNivel(nivel) {
  const s = String(nivel || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
  if (!s) return ''
  if (/(^|\b)pos(\b|-|graduacao|\s)/.test(s) || s.includes('pos-graduacao') || s.includes('especializacao')) return 'pos'
  if (s.includes('graduacao') || s.includes('bacharel') || s.includes('licenciatura') || s.includes('tecnolog')) return 'graduacao'
  return ''
}

/** Lê o campo sum_Nivel do objeto lead do Kommo (custom_fields_values). */
function extractNivelFromLead(env, lead) {
  const fieldId = Number(env.KOMMO_FIELD_SUM_NIVEL_ID) || DEFAULT_SUM_NIVEL_FIELD_ID
  const fields = lead?.custom_fields_values
  if (!Array.isArray(fields)) return ''
  const f = fields.find((x) => Number(x?.field_id) === fieldId)
  const v = f?.values?.[0]?.value
  return v ? String(v).trim() : ''
}

/**
 * Monta a saudação inicial personalizada.
 * @param {{ nome?: string, nivel?: string }} opts
 */
export function buildGreeting({ nome, nivel } = {}) {
  const name = firstName(nome)
  const lvl = normalizeNivel(nivel)
  const ola = name ? `Olá, ${name}! 😊` : 'Olá! 😊'
  const nivelFrase =
    lvl === 'pos'
      ? ' Vi que você demonstrou interesse na nossa pós-graduação.'
      : lvl === 'graduacao'
        ? ' Vi que você demonstrou interesse na nossa graduação.'
        : ''
  return (
    `${ola} Sou o assistente virtual da Faculdade Sumaré.${nivelFrase}` +
    ' Posso te ajudar com informações sobre cursos, valores, bolsas e matrícula.' +
    ' Você já tem algum curso em mente ou prefere que eu te apresente as opções?'
  )
}

async function hasPriorAttendance(env, telefone, leadId) {
  try {
    const sid = phoneToWhatsAppSessionId(telefone)
    const buf = await getMessages(env, sid)
    if (buf?.length) return { attended: true, reason: 'buffer_pending' }
  } catch {
    /* ignore */
  }

  try {
    const mem = await runBuscarHistorico(env, { telefone, limit: 8 })
    if (mem.ok && (mem.mensagens || []).some((m) => m.role === 'assistente')) {
      return { attended: true, reason: 'n8n_memory' }
    }
  } catch {
    /* ignore */
  }

  try {
    const rows = await fetchRecentChatRows(env, telefone, 12)
    if (rows.some((r) => String(r?.bot_message || '').trim())) {
      return { attended: true, reason: 'chat_messages' }
    }
  } catch {
    /* ignore */
  }

  if (Number.isFinite(Number(leadId)) && Number(leadId) > 0) {
    try {
      const notes = await listLeadNotes(env, leadId, { limit: 20 })
      for (const n of notes.notes || []) {
        const t = String(n.params?.text || '').trim()
        if (AGENT_NOTE_RE.test(t)) return { attended: true, reason: 'kommo_note' }
      }
    } catch {
      /* ignore */
    }
  }

  return { attended: false }
}

/**
 * Claim atômico: só uma réplica/tick consegue marcar proactive_greet_at quando
 * está NULL. Retorna 'claimed' | 'taken' | 'no_column'.
 */
async function claimGreetExclusive(env, telefone) {
  const { url, key, table } = getDadosClienteCfg(env)
  const telFilter = dadosClienteTelefoneOrFilter(telefone)
  if (!url || !key || !telFilter) return 'no_column'
  const nowIso = new Date().toISOString()
  try {
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?${telFilter}&${FIELD_GREET_AT}=is.null`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ [FIELD_GREET_AT]: nowIso }),
      },
    )
    if (!res.ok) {
      // 400/PGRST204 => coluna provavelmente não existe; cai no fallback memória.
      return 'no_column'
    }
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (Array.isArray(data) && data.length > 0) return 'claimed'
    // PATCH ok mas 0 linhas: ou já tinha valor, ou não há row p/ esse telefone.
    return 'taken'
  } catch {
    return 'no_column'
  }
}

async function setGreetField(env, telefone, value) {
  try {
    return await updateDadosCliente(env, { telefone, fields: { [FIELD_GREET_AT]: value } })
  } catch {
    return { ok: false }
  }
}

async function resolveLeadId(env, { leadId, telefone }) {
  const id = Number(leadId)
  if (Number.isFinite(id) && id > 0) return id
  if (!telefone) return null
  try {
    const lookup = await findLeadByPhone(env, telefone)
    if (lookup.ok && lookup.lead?.id) return Number(lookup.lead.id)
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Tenta enviar a saudação proativa para um lead.
 *
 * @param {Record<string,string>} env
 * @param {{
 *   telefone: string,
 *   leadId?: number,
 *   lead?: object,
 *   nome?: string,
 *   nivel?: string,
 *   source?: string,
 * }} input
 * @returns {Promise<{ action: string, reason?: string, [k:string]: any }>}
 */
export async function tryProactiveGreet(env, input = {}) {
  if (!isProactiveGreetEnabled(env)) return { action: 'disabled' }

  const telefone = input.telefone
  const lead = input.lead
  const source = input.source || 'unknown'
  if (!telefone) return { action: 'skip', reason: 'missing_telefone' }

  const leadId = await resolveLeadId(env, { leadId: input.leadId, telefone })

  const nome = input.nome || lead?.name || ''
  const nivel = input.nivel || (lead ? extractNivelFromLead(env, lead) : '')

  // Estado do cliente: pausa da IA, inscrição ativa, saudação já feita.
  let cliente = {}
  try {
    cliente =
      (await fetchDadosClienteByTelefone(
        env,
        telefone,
        `atendimento_ia,${FIELD_GREET_AT},${FORM_STATUS_FIELD}`,
      )) || {}
  } catch {
    cliente = {}
  }
  if (String(cliente?.atendimento_ia || '').toLowerCase() === 'pause') {
    return { action: 'skip', reason: 'ia_paused' }
  }
  const formStatus = String(cliente?.[FORM_STATUS_FIELD] || '').trim()
  if (formStatus && SKIP_INSCRICAO_STATUSES.has(formStatus)) {
    return { action: 'skip', reason: 'inscricao_flow_active', formStatus }
  }
  if (cliente?.[FIELD_GREET_AT]) {
    return { action: 'skip', reason: 'already_greeted' }
  }

  const fone = normalizeTelefone(telefone)
  const memAt = _greetMemory.get(fone)
  if (memAt && Date.now() - memAt < GREET_MEMORY_TTL_MS) {
    return { action: 'skip', reason: 'greeted_recently_memory' }
  }

  // Já houve qualquer atendimento prévio? Não saudar de novo.
  const prior = await hasPriorAttendance(env, telefone, leadId)
  if (prior.attended) {
    // Marca pra não reavaliar o histórico todo tick.
    _greetMemory.set(fone, Date.now())
    await setGreetField(env, telefone, new Date().toISOString()).catch(() => {})
    return { action: 'skip', reason: `already_attended:${prior.reason}` }
  }

  // Claim atômico persistente. Se a coluna não existir, usa memória + dedupe de outbound.
  const claim = await claimGreetExclusive(env, telefone)
  if (claim === 'taken') {
    _greetMemory.set(fone, Date.now())
    return { action: 'skip', reason: 'greet_claim_taken' }
  }

  const text = buildGreeting({ nome, nivel })
  const executionId = generateExecutionId()
  const sendRes = await sendMessageWithNote(env, {
    telefone,
    text,
    leadId: leadId || undefined,
    executionId,
  })

  if (!sendRes?.ok) {
    // Libera o claim pra tentar de novo no próximo gatilho.
    if (claim === 'claimed') await setGreetField(env, telefone, null).catch(() => {})
    return { action: 'greet_failed', error: sendRes?.error || sendRes?.code }
  }
  if (sendRes.deduped) {
    _greetMemory.set(fone, Date.now())
    return { action: 'skip', reason: 'greet_deduped_outbound' }
  }

  const nowIso = new Date().toISOString()
  _greetMemory.set(fone, Date.now())
  if (claim !== 'claimed') {
    // Sem claim persistente (coluna ausente): tenta gravar mesmo assim.
    await setGreetField(env, telefone, nowIso).catch(() => {})
  }
  await appendChatMemory(env, { telefone, userMessage: '', botMessage: text }).catch(() => {})
  await saveConversation(env, {
    telefone,
    userMessage: '',
    botMessage: text,
    messageType: 'proactive_greet',
    idLead: leadId || undefined,
    createdAt: nowIso,
  }).catch(() => {})

  console.log(
    `[proactive-greet] lead=${leadId ?? 'n/a'} source=${source} saudação enviada exec=${executionId}`,
  )
  return { action: 'greet_sent', text, executionId, leadId }
}
