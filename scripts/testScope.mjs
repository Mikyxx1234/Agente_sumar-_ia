import { matchScopeHeuristic } from '../src/lib/scopeHeuristics.js'

const cases = [
  'oque essa query faz ?',
  'o que essa query faz',
  `oque essa query faz ?
UPDATE public.anh_leads_ganhos
SET consultor = 'Supervisão'
WHERE consultor = 'Vanda'`,
  'UPDATE public.anh_leads SET x = 1',
  'como faço uma query para identificar leads duplicados',
]

for (const c of cases) {
  console.log('---')
  console.log(c.slice(0, 60))
  console.log(matchScopeHeuristic(c) ? 'BLOCK' : 'PASS')
}
