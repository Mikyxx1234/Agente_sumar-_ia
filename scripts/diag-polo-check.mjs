import * as m from '../libShared/sumarePoloCatalog.js'

for (const p of m.SUMARE_POLOS_EAD) console.log(p.nome, '->', m.resolvePoloUnidadeCode(p.id))
console.log('---')
for (const q of ['barra funda', 'tatuape', 'santana', 'sao miguel', 'santo amaro', '5', 'Pinheiros']) {
  const r = m.matchPoloFromUserMessage(q)
  console.log(`match "${q}":`, r ? `${r.nome} (${m.resolvePoloUnidadeCode(r.id)})` : 'NULL')
}
console.log('unlisted "quero santo amaro"?', m.messageMentionsUnlistedPoloLocation('quero santo amaro'))
console.log('--- LISTA ---')
console.log(m.formatPoloListaNumerada())
