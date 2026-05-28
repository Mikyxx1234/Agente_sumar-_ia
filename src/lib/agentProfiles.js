import {
  LayoutDashboard, FileText, FlaskConical, ListChecks,
  Database, GraduationCap, Filter, ShieldCheck,
  Sparkles, ClipboardCheck,
} from 'lucide-react'

/**
 * Status IDs no Kommo (pipeline AGENTE-SUMARÉ = 13756724)
 * - ATENDIMENTO         → 106140284  (Agente Atendimento — KOMMO_AGENT_STATUS_ID)
 * - AGUARDANDO RESPOSTA → 106377088  (Agente Atendimento — após enviar mensagem ao lead)
 * - INSCRIÇÃO           → 106804680  (Agente Inscrição)
 * - AGUARDANDO PAGAMENTO → 106426128 (Agente Inscrição — também KOMMO_POS_MATRICULA_STATUS_ID)
 */
export const KOMMO_AGENTE_SUMARE_PIPELINE_ID = 13756724
export const KOMMO_STATUS_ATENDIMENTO = 106140284
export const KOMMO_STATUS_AGUARDANDO_RESPOSTA = 106377088
export const KOMMO_STATUS_INSCRICAO = 106804680
export const KOMMO_STATUS_AGUARDANDO_PAGAMENTO = 106426128

const ATENDIMENTO_STATUS_IDS = [KOMMO_STATUS_ATENDIMENTO, KOMMO_STATUS_AGUARDANDO_RESPOSTA]
const INSCRICAO_STATUS_IDS = [KOMMO_STATUS_INSCRICAO, KOMMO_STATUS_AGUARDANDO_PAGAMENTO]

export const PROFILES = {
  atendimento: {
    id: 'atendimento',
    label: 'Agente Atendimento',
    sub: 'Painel da IA',
    description: '7 abas · atendimento + comercial',
    icon: Sparkles,
    /**
     * Escopo em modo EXCLUSÃO: mostra dados de TODOS os leads exceto
     * aqueles que estão nas colunas do Agente Inscrição (INSCRIÇÃO +
     * AGUARDANDO PAGAMENTO). Funciona para qualquer outra coluna
     * (ATENDIMENTO, AGUARDANDO RESPOSTA, etc.) sem precisar listar IDs.
     */
    kommoScope: {
      pipelineId: KOMMO_AGENTE_SUMARE_PIPELINE_ID,
      statusIds: INSCRICAO_STATUS_IDS,
      mode: 'exclude',
    },
    /**
     * Escopo do Funil Kommo do Atendimento: lista explícita das colunas
     * do agente (ATENDIMENTO + AGUARDANDO RESPOSTA). Necessário porque
     * o endpoint do Kommo só sabe filtrar por inclusão (não tem "not in").
     */
    kommoFunnelScope: {
      pipelineId: KOMMO_AGENTE_SUMARE_PIPELINE_ID,
      statusIds: ATENDIMENTO_STATUS_IDS,
    },
    nav: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { id: 'funil-kommo', label: 'Funil Kommo', icon: Filter },
      { id: 'prompts', label: 'Prompts', icon: FileText },
      { id: 'playground', label: 'Teste IA', icon: FlaskConical },
      { id: 'executions', label: 'Execuções', icon: ListChecks },
      { id: 'feedback-ia', label: 'Feedback IA', icon: ShieldCheck },
      { id: 'knowledge-update', label: 'Atualização IA', icon: Database },
    ],
    defaultPage: 'dashboard',
  },
  inscricao: {
    id: 'inscricao',
    label: 'Agente Inscrição',
    sub: 'Automação de matrículas',
    description: '5 abas · dashboard + execuções + funil',
    icon: ClipboardCheck,
    kommoScope: {
      pipelineId: KOMMO_AGENTE_SUMARE_PIPELINE_ID,
      statusIds: INSCRICAO_STATUS_IDS,
      mode: 'include',
    },
    kommoFunnelScope: {
      pipelineId: KOMMO_AGENTE_SUMARE_PIPELINE_ID,
      statusIds: INSCRICAO_STATUS_IDS,
    },
    nav: [
      { id: 'inscricao-dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { id: 'inscricao-execucoes', label: 'Execuções', icon: ListChecks },
      { id: 'inscricao-matriculas', label: 'Matrículas', icon: GraduationCap },
      { id: 'inscricao-feedback', label: 'Feedback IA', icon: ShieldCheck },
      { id: 'inscricao-funil', label: 'Funil Kommo (Inscrição)', icon: Filter },
    ],
    defaultPage: 'inscricao-dashboard',
  },
}

export const PROFILE_LIST = Object.values(PROFILES)
export const DEFAULT_PROFILE_ID = PROFILES.atendimento.id

const STORAGE_PROFILE = 'agent_profile'
const STORAGE_PAGE_BY_PROFILE = 'agent_profile_page'

export function getProfile(profileId) {
  return PROFILES[profileId] || PROFILES[DEFAULT_PROFILE_ID]
}

export function loadProfile() {
  try {
    const v = localStorage.getItem(STORAGE_PROFILE)
    if (v && PROFILES[v]) return v
  } catch {
    // ignore
  }
  return DEFAULT_PROFILE_ID
}

export function saveProfile(profileId) {
  try {
    localStorage.setItem(STORAGE_PROFILE, profileId)
  } catch {
    // ignore
  }
}

export function loadPageForProfile(profileId) {
  const profile = getProfile(profileId)
  try {
    const raw = localStorage.getItem(STORAGE_PAGE_BY_PROFILE)
    const map = raw ? JSON.parse(raw) : {}
    const candidate = map[profileId]
    if (candidate && profile.nav.some((n) => n.id === candidate)) {
      return candidate
    }
  } catch {
    // ignore
  }
  return profile.defaultPage
}

export function savePageForProfile(profileId, pageId) {
  try {
    const raw = localStorage.getItem(STORAGE_PAGE_BY_PROFILE)
    const map = raw ? JSON.parse(raw) : {}
    map[profileId] = pageId
    localStorage.setItem(STORAGE_PAGE_BY_PROFILE, JSON.stringify(map))
  } catch {
    // ignore
  }
}
