/**
 * Matrículas realizadas pelo agente (Supabase).
 *
 * Tabela principal (quando existir): matriculas_realizadas
 * Fallback legado: inscricao_ab (só id_lead + atendimento)
 *
 * Colunas esperadas em matriculas_realizadas (sugestão para o backend):
 *   id, created_at, id_lead, nome, telefone, curso, tipo_ingresso, polo,
 *   status, execution_id, payload (jsonb), erro
 */

const isDev = import.meta.env.DEV
const BASE = isDev ? '/api/supabase' : '/api/supabase'

const TABLE_PRIMARY = import.meta.env.VITE_MATRICULAS_TABLE || 'matriculas_realizadas'
const TABLE_LEGACY = 'inscricao_ab'

async function supabaseGet(path) {
  const res = await fetch(`${BASE}/rest/v1/${path}`)
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: err }
  }
  const data = await res.json()
  return { ok: true, data }
}

function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') return row[k]
  }
  return null
}

function mapMatriculaRow(r) {
  const statusRaw = pick(r, 'status', 'Status') || 'concluida'
  return {
    id: String(pick(r, 'id') ?? `${r.id_lead}-${r.created_at}`),
    leadId: pick(r, 'id_lead', 'idLead', 'lead_id'),
    nome: pick(r, 'nome', 'nome_candidato', 'nome_aluno', 'Nome'),
    telefone: pick(r, 'telefone', 'phone', 'Telefone'),
    curso: pick(r, 'curso', 'Curso'),
    tipoIngresso: pick(r, 'tipo_ingresso', 'tipoIngresso', 'Tipo de ingresso'),
    polo: pick(r, 'polo', 'Polo'),
    status: String(statusRaw).toLowerCase(),
    executionId: pick(r, 'execution_id', 'executionId'),
    erro: pick(r, 'erro', 'error'),
    payload: r.payload ?? r.dados ?? r.metadata ?? null,
    createdAt: pick(r, 'created_at', 'createdAt') || new Date().toISOString(),
    source: 'matriculas_realizadas',
    raw: r,
  }
}

function mapInscricaoAbRow(r) {
  return {
    id: `ab-${r.id_lead}-${r.created_at || 'na'}`,
    leadId: r.id_lead,
    nome: null,
    telefone: null,
    curso: null,
    tipoIngresso: null,
    polo: null,
    status: 'registro_parcial',
    executionId: null,
    erro: null,
    payload: null,
    createdAt: r.created_at || null,
    atendimento: r.Atendimento || r.atendimento || null,
    source: 'inscricao_ab',
    raw: r,
  }
}

export async function getAllMatriculas() {
  const primary = await supabaseGet(
    `${TABLE_PRIMARY}?select=*&order=created_at.desc&limit=500`,
  )

  if (primary.ok && Array.isArray(primary.data)) {
    return {
      rows: primary.data.map(mapMatriculaRow),
      source: TABLE_PRIMARY,
      tableReady: true,
    }
  }

  if (primary.status !== 404 && primary.status !== 400) {
    console.warn('[MatriculasStore] matriculas_realizadas:', primary.status, primary.error)
  }

  const legacy = await supabaseGet(
    `${TABLE_LEGACY}?select=*&order=created_at.desc&limit=500`,
  )

  if (legacy.ok && Array.isArray(legacy.data)) {
    return {
      rows: legacy.data.map(mapInscricaoAbRow),
      source: TABLE_LEGACY,
      tableReady: false,
      hint: 'Usando registros parciais de inscricao_ab. Quando a matrícula automática estiver ativa, preencha a tabela matriculas_realizadas.',
    }
  }

  return {
    rows: [],
    source: null,
    tableReady: false,
    hint: 'Nenhuma tabela de matrículas encontrada ainda. Os registros aparecerão aqui quando o agente concluir matrículas automáticas.',
  }
}
