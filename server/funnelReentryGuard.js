/**
 * Quando um lead finalizado sai do funil e volta, o poll Kommo pode reempurrar
 * mensagens antigas no buffer e o pós-form dispara de novo. Limpamos o buffer
 * na reentrada se a matrícula pós-formulário já foi processada.
 */

import { clearMessages } from './evolution/messageBuffer.js'
import { fetchDadosClienteByTelefone } from './dadosClienteStore.js'
import { matriculaPosFormAlreadyProcessed } from '../libShared/inscricaoFormHeuristics.js'
import { DADOS_CLIENTE_INSCRICAO_SELECT } from './dadosClienteInscricaoFields.js'

/**
 * @returns {Promise<{ cleared: boolean, reason?: string }>}
 */
export async function isMatriculaPosFormDoneForTelefone(env, telefone) {
  const row = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_INSCRICAO_SELECT)
  return matriculaPosFormAlreadyProcessed(row)
}

export async function clearStaleBufferIfMatriculaDone(env, { telefone, sessionId }) {
  if (!telefone || !sessionId) return { cleared: false, reason: 'missing_session' }
  const row = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_INSCRICAO_SELECT)
  if (!matriculaPosFormAlreadyProcessed(row)) {
    return { cleared: false, reason: 'matricula_not_done' }
  }
  const removed = await clearMessages(env, sessionId)
  return { cleared: removed > 0, reason: removed > 0 ? 'buffer_cleared' : 'buffer_already_empty' }
}
