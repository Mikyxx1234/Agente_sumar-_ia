/**
 * Colunas de inscrição/matrícula que existem em `dados_cliente_sum`.
 * Evita SELECT/PATCH com campos inexistentes (PostgREST 400 → row null → guards falham).
 */

/** SELECT seguro para guards de pós-formulário. */
export const DADOS_CLIENTE_INSCRICAO_SELECT =
  'id,telefone,inscricao_form_status,inscricao_form_recebido_at,atendimento_ia'

/** SELECT para bloquear reenvio indevido do Formulario_Sum. */
export const DADOS_CLIENTE_FORM_GUARD_SELECT =
  `${DADOS_CLIENTE_INSCRICAO_SELECT},captacao_candidato_id,captacao_contrato_link,captacao_contrato_link_at`

/**
 * SELECT estendido para o fluxo express via card Kommo
 * (Plano_Inscricao_CardKommo): inclui as colunas espelhadas do card.
 */
export const DADOS_CLIENTE_KOMMO_MIRROR_SELECT =
  'id,telefone,inscricao_form_status,inscricao_form_recebido_at,atendimento_ia,' +
  'polo_inscricao_escolhido,captacao_unidade,' +
  'kommo_nome,kommo_cpf,kommo_email,kommo_data_nasc,kommo_curso,kommo_polo,kommo_modalidade,kommo_status_inscricao,kommo_sync_at'

/** Prefixos da mensagem padrão quando captação/salesbot conclui o pós-form (dedupe outbound). */
export const POST_FORM_REGISTRADO_PREFIX =
  'obrigado! registramos o formulário. um consultor da faculdade sumaré'

const POST_FORM_REGISTRADO_PREFIXES = [
  POST_FORM_REGISTRADO_PREFIX,
  'obrigado! recebemos seu formulário',
  'obrigado! recebemos seu formulario',
]

export function isPostFormRegistradoBoilerplate(text) {
  const t = String(text || '')
    .replace(/\s-\s+EX-\d{6}-\d{4}-\d{3}(-[a-f0-9]+)?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return POST_FORM_REGISTRADO_PREFIXES.some((p) => t.startsWith(p))
}
