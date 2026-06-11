/**
 * Unit: variantes de sessionId do "9º dígito" de celular BR.
 * npm run test:phone-variants
 *
 * Caso real que motivou o fix: lead com telefone Kommo +5511920464401 (com 9)
 * e mensagem do WhatsApp em 551120464401 (sem 9) — buffers em chaves diferentes,
 * scheduler lia vazio e nunca respondia.
 */

import {
  phoneToWhatsAppSessionId,
  whatsAppSessionVariants,
} from '../server/phoneWhatsApp.js'

const stats = { passed: 0, failed: 0, total: 0 }

function expect(label, ok) {
  stats.total += 1
  if (ok) {
    stats.passed += 1
    console.log(`  ok ${label}`)
  } else {
    stats.failed += 1
    console.error(`  FAIL ${label}`)
  }
}

function sameSet(a, b) {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  return b.every((x) => sa.has(x))
}

// Caso real: sem o 9 → também gera a variante com o 9.
const semNove = whatsAppSessionVariants('551120464401')
expect(
  'sem o 9 → primária é a própria',
  semNove[0] === '551120464401@s.whatsapp.net',
)
expect(
  'sem o 9 → inclui variante com o 9',
  semNove.includes('5511920464401@s.whatsapp.net'),
)
expect(
  'sem o 9 → exatamente 2 variantes',
  semNove.length === 2 &&
    sameSet(semNove, [
      '551120464401@s.whatsapp.net',
      '5511920464401@s.whatsapp.net',
    ]),
)

// Caminho reverso: com o 9 → também gera a variante sem o 9.
const comNove = whatsAppSessionVariants('+5511920464401')
expect(
  'com o 9 → primária é a própria',
  comNove[0] === '5511920464401@s.whatsapp.net',
)
expect(
  'com o 9 → inclui variante sem o 9',
  comNove.includes('551120464401@s.whatsapp.net'),
)

// Ida e volta resolvem para o mesmo conjunto.
expect('ida e volta → mesmo conjunto', sameSet(semNove, comNove))

// Celular "normal" (DDD 11, 9XXXXXXXX) → gera a forma legada sem o 9.
const celular = whatsAppSessionVariants('5511998561302')
expect(
  'celular 9XXXXXXXX → primária com 9',
  celular[0] === '5511998561302@s.whatsapp.net',
)
expect(
  'celular 9XXXXXXXX → variante sem 9',
  celular.includes('5511985613020@s.whatsapp.net') === false &&
    celular.includes('551198561302@s.whatsapp.net'),
)

// Kommo guarda DDD+número sem o 55 → normaliza para 55... e gera variante.
const semDdi = whatsAppSessionVariants('11920464401')
expect(
  'sem DDI → primária recebe 55',
  semDdi[0] === phoneToWhatsAppSessionId('11920464401'),
)

// Entradas inválidas não quebram.
expect('vazio → []', whatsAppSessionVariants('').length === 0)
expect('null → []', whatsAppSessionVariants(null).length === 0)

console.log(`\n${stats.passed}/${stats.total} passed`)
if (stats.failed > 0) process.exit(1)
