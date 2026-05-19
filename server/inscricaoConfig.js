/**
 * Controle da fase de matrícula: automática (Kommo) vs consultor humano.
 * Default: automática desligada — o agente coleta dados e chama distribuir_humano.
 */

export function isInscricaoAutomaticaEnabled(env = process.env) {
  return String(env?.INSCRICAO_AUTOMATICA_ENABLED ?? 'false').trim().toLowerCase() === 'true'
}

/** Texto devolvido à IA quando inscricao é chamada com automação desligada. */
export function matriculaViaConsultorInstruction(args = {}) {
  const curso = args.curso ? String(args.curso).trim() : ''
  const tipo = args.tipo_ingresso ? String(args.tipo_ingresso).trim() : ''
  const lines = [
    'Matrícula automática no Kommo está DESLIGADA — um consultor humano finaliza a matrícula.',
  ]
  if (curso && tipo) {
    lines.push(`Interesse anotado: curso="${curso}", tipo_ingresso="${tipo}".`)
  } else if (curso) {
    lines.push(`Curso anotado: "${curso}". Confirme tipo de ingresso (ENEM ou Vestibular Múltipla Escolha) pelo histórico se ainda faltar.`)
  } else {
    lines.push('Use o histórico da conversa para curso e tipo de ingresso antes de encaminhar.')
  }
  lines.push(
    'INSTRUÇÃO OBRIGATÓRIA NESTE TURNO: chame distribuir_humano passando o telefone do Contexto, motivo: "matricula" (salesbot 49813).',
    'PROIBIDO: pedir outro telefone, dizer que não achou cadastro, mandar usar canal padrão externo, ou afirmar que a matrícula já está concluída.',
    'Responda ao lead de forma acolhedora: um consultor da Faculdade Sumaré entrará em breve para finalizar a matrícula.',
  )
  return lines.join('\n')
}
