/**
 * Valida heurísticas de nível grad/pós (casos Edilson e similares).
 * Uso: node scripts/validate-grade-nivel.mjs
 */
import { detectNivel, isNivelCorrectionMessage } from '../libShared/gradeNivelHeuristics.js'
import { findGradeRow } from '../libShared/gradeCurricularPdfService.js'

const cases = [
  {
    name: 'tecnologia logística → grad',
    fn: () =>
      detectNivel({ userMessage: 'Grade curricular do curso tecnologia em logística?' }) === 'grad',
  },
  {
    name: 'não é pós, é graduação → grad',
    fn: () => detectNivel({ userMessage: 'Não é pós, é graduação' }) === 'grad',
  },
  {
    name: 'MBA em logística → pos',
    fn: () => detectNivel({ userMessage: 'MBA em logística' }) === 'pos',
  },
  {
    name: 'correção nível detectada',
    fn: () => isNivelCorrectionMessage('Não é pós, é graduação'),
  },
  {
    name: 'findGradeRow logística null nivel → grad Logística',
    fn: () => {
      const row = findGradeRow({ curso: 'tecnologia em logística' })
      return row && row.nivel === 'grad' && /log/i.test(row.nome || row.id)
    },
  },
  {
    name: 'findGradeRow MBA explícito → pos',
    fn: () => {
      const row = findGradeRow({ curso: 'MBA em Operações e Logística' })
      return row && row.nivel === 'pos'
    },
  },
]

let failed = 0
for (const c of cases) {
  const ok = Boolean(c.fn())
  console.log(`${ok ? 'OK' : 'FAIL'} — ${c.name}`)
  if (!ok) failed++
}
process.exit(failed > 0 ? 1 : 0)
