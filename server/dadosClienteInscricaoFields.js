/**
 * Colunas de inscrição/matrícula que existem em `dados_cliente_sum`.
 * Evita SELECT/PATCH com campos inexistentes (PostgREST 400 → row null → guards falham).
 */

/** SELECT seguro para guards de pós-formulário. */
export const DADOS_CLIENTE_INSCRICAO_SELECT =
  'id,telefone,inscricao_form_status,inscricao_form_recebido_at,atendimento_ia'

/** Prefixo da mensagem padrão quando captação/salesbot não conclui (dedupe outbound). */
export const POST_FORM_REGISTRADO_PREFIX =
  'obrigado! registramos o formulário. um consultor da faculdade sumaré'

export function isPostFormRegistradoBoilerplate(text) {
  const t = String(text || '')
    .replace(/\s-\s+EX-\d{6}-\d{4}-\d{3}\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return t.startsWith(POST_FORM_REGISTRADO_PREFIX)
}
