/**
 * Regressão: findLastFormularioSumSentMs deve ignorar notas de formulário
 * fora da janela de idade (maxAgeMs). Sem o cap, uma nota antiga (ex.: dias
 * atrás após reset) re-ancora a detecção por eventos de campo e re-dispara o
 * pós-formulário sobre dados velhos, pausando a IA (distribuir_consultor).
 *
 * node scripts/test-form-notes-age-cap.mjs
 */

import { findLastFormularioSumSentMs } from '../libShared/kommoFormNotes.js'

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

const NOW = Date.parse('2026-06-01T13:00:00Z')
const H = 3600000

function formNote(iso) {
  return { created_at: iso, params: { text: 'Salesbot Formulario_Sum ativado' } }
}

const noteOld = formNote('2026-05-29T16:13:00Z') // ~69h atrás
const noteRecent = formNote('2026-06-01T11:00:00Z') // 2h atrás

// Sem cap: pega a última nota independente da idade (comportamento legado).
expect(
  'sem cap: nota antiga ainda é âncora',
  findLastFormularioSumSentMs([noteOld]) === Date.parse('2026-05-29T16:13:00Z'),
)

// Com cap 48h e só nota velha: não há referência (0) -> field-events NÃO dispara.
expect(
  'cap 48h: nota velha (69h) ignorada -> 0',
  findLastFormularioSumSentMs([noteOld], { maxAgeMs: 48 * H, nowMs: NOW }) === 0,
)

// Com cap 48h e nota recente: mantém a âncora recente.
expect(
  'cap 48h: nota recente (2h) mantida',
  findLastFormularioSumSentMs([noteRecent], { maxAgeMs: 48 * H, nowMs: NOW }) ===
    Date.parse('2026-06-01T11:00:00Z'),
)

// Com cap 48h e ambas: ignora a velha, retorna a recente.
expect(
  'cap 48h: mistura velha+recente -> retorna recente',
  findLastFormularioSumSentMs([noteOld, noteRecent], { maxAgeMs: 48 * H, nowMs: NOW }) ===
    Date.parse('2026-06-01T11:00:00Z'),
)

// Sem notas de formulário: 0 em qualquer modo.
expect('sem nota de formulário -> 0', findLastFormularioSumSentMs([], { maxAgeMs: 48 * H, nowMs: NOW }) === 0)

// maxAgeMs inválido (0/NaN) = sem cap.
expect(
  'maxAgeMs=0 desativa o cap',
  findLastFormularioSumSentMs([noteOld], { maxAgeMs: 0, nowMs: NOW }) ===
    Date.parse('2026-05-29T16:13:00Z'),
)

console.log(`\n${stats.passed}/${stats.total} passed`)
if (stats.failed > 0) process.exit(1)
