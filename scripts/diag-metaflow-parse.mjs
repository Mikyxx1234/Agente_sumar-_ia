import {
  parseMetaFlowResponseJson,
  messageIsMetaFlowFormReply,
  normalizeBrazilPhone,
  formatDateToDDMMYYYY,
} from '../libShared/metaFlowFormParser.js'

// Sample exato do pinData do workflow n8n (response_json do Meta Flow).
const responseJson =
  '{"TextInput_1475361_2":"tstasdads","TextInput_1475363_2":"12321321213","TextInput_1475397_2":"213123123123","TextInput_1475395_2":"asdasdas\\u0040casd.com.br","Dropdown_1475971_2":"1194759","TextInput_1475467_2":"08092000","flow_token":"unused"}'

// Como chega no buffer do agente (metaWebhook):
const bufferText = `[FORMULARIO SUMAR]: ${responseJson}`

console.log('messageIsMetaFlowFormReply(buffer):', messageIsMetaFlowFormReply(bufferText))
console.log('messageIsMetaFlowFormReply("oi"):', messageIsMetaFlowFormReply('oi'))
console.log('\nparse(buffer):')
console.log(JSON.stringify(parseMetaFlowResponseJson(bufferText), null, 2))

console.log('\n--- normalizacao isolada ---')
console.log('phone 11 dig:', normalizeBrazilPhone('11944690752'))
console.log('phone ja com 55:', normalizeBrazilPhone('5511944690752'))
console.log('data 8 dig:', formatDateToDDMMYYYY('08092000'))
console.log('data iso:', formatDateToDDMMYYYY('2000-09-08'))
console.log('data ja ok:', formatDateToDDMMYYYY('08/09/2000'))

// Caso realista (telefone BR com DDD)
const real =
  '[FORMULARIO SUMAR]: {"TextInput_1475361_2":"Maria Souza","TextInput_1475363_2":"123.456.789-09","TextInput_1475397_2":"11944690752","TextInput_1475395_2":"maria@gmail.com","Dropdown_1475971_2":"1194759","TextInput_1475467_2":"02/04/1999"}'
console.log('\nparse(real):')
console.log(JSON.stringify(parseMetaFlowResponseJson(real), null, 2))
