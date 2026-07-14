/**
 * Controle da fase de matrícula: automática (Kommo) vs consultor humano.
 * Default: automática desligada — o agente coleta dados e chama distribuir_humano.
 */

export function isInscricaoAutomaticaEnabled(env = process.env) {
  return String(env?.INSCRICAO_AUTOMATICA_ENABLED ?? 'false').trim().toLowerCase() === 'true'
}

/** Valor usado só no backend (API/Kommo) quando o lead não informou forma de ingresso. */
export function getDefaultTipoIngresso(env = process.env) {
  return String(env?.SUMARE_CAPTACAO_TIPO_INGRESSO_DEFAULT || 'Vestibular').trim() || 'Vestibular'
}

export function matriculaViaConsultorInstruction(args = {}) {
  const curso = args.curso ? String(args.curso).trim() : ''
  const lines = [
    'Matrícula automática no Kommo está DESLIGADA — um consultor humano finaliza a matrícula.',
  ]
  if (curso) {
    lines.push(`Curso anotado: "${curso}".`)
  } else {
    lines.push('Use o histórico da conversa para identificar o curso de interesse antes de encaminhar.')
  }
  lines.push(
    'NÃO pergunte ao lead se o ingresso é ENEM ou Vestibular — a inscrição segue sem essa pergunta.',
  )
  lines.push(
    'INSTRUÇÃO: o sistema ativará o salesbot Kommo Formulario_Sum (formulário no WhatsApp). Após o preenchimento: salesbot 49813 (matrícula) e pausa da IA.',
    'PROIBIDO: pedir outro telefone, dizer que não achou cadastro, mandar usar canal padrão externo, afirmar que a matrícula já está concluída, ou prometer que um consultor entrará em contato.',
    'Responda ao lead de forma acolhedora, reforçando que o formulário segue automaticamente pelo sistema.',
  )
  return lines.join('\n')
}
