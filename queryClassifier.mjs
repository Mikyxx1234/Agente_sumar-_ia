/**
 * Classificação pura (sem I/O) para RAG Sumaré — compartilhada entre
 * `server/ai/knowledgeSearch.js` e `src/lib/supabaseSearch.js` (Playground).
 */

const PRECO = [
  'preço', 'preco', 'valor', 'mensalidade', 'quanto custa', 'desconto', 'pagamento',
  'boleto', 'pix', 'investimento', 'promoção', 'promocao', 'taxa', 'parcela', 'parcelas',
  'condição', 'condicoes', 'financiamento', 'custar', 'custa', 'reajuste',
]

const POS = [
  'pós', 'pos ', 'pos-', 'pós-', 'pós graduação', 'pos graduacao', 'pós-graduação',
  'pos-graduacao', 'pós graduação', 'pos graduação', 'especialização', 'especializacao',
  'mba', 'lato sensu', 'latu sensu', 'stricto', 'mestrado',
]

const GRAD = [
  'graduação', 'graduacao', 'faculdade', 'bacharelado', 'licenciatura', 'tecnólogo',
  'tecnologo', 'curso superior', ' superior', 'ead', 'presencial', 'semipresencial',
  'semi presencial',
]

const INFO_EXTRA = [
  'curso', 'duração', 'duracao', 'modalidade', 'grade', 'matérias', 'materias',
  'documentação', 'documentacao', 'matrícula', 'matricula', 'inscrição', 'inscricao',
  'como funciona', 'polo', 'início', 'inicio', 'prova', 'estágio', 'estagio', 'tcc',
  'diploma', 'calendário', 'calendario', 'portal', 'secretaria', 'disciplina',
]

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

function hasAny(hay, needles) {
  const h = norm(hay)
  return needles.some((n) => h.includes(norm(n)))
}

/**
 * @param {string} question
 * @returns {{ level: 'pos' | 'grad' | 'ambiguous', intent: 'preco' | 'info' | 'mista' }}
 */
export function classifyKnowledgeQuery(question) {
  const q = String(question || '')
  const n = norm(q)

  const hasPreco = hasAny(q, PRECO)
  const hasPos = hasAny(q, POS) || /\bpos\b/i.test(q)
  const hasGrad = hasAny(q, GRAD)
  const hasInfoExtra = hasAny(q, INFO_EXTRA)

  let level = 'ambiguous'
  if (hasPos && !hasGrad) level = 'pos'
  else if (hasGrad && !hasPos) level = 'grad'
  else if (hasPos && hasGrad) level = 'ambiguous'

  let intent = 'info'
  if (hasPreco && (hasInfoExtra || hasPos || hasGrad)) intent = 'mista'
  else if (hasPreco) intent = 'preco'
  else if (hasInfoExtra || n.length > 0) intent = 'info'

  return { level, intent }
}

/**
 * Quais RPCs chamar (ordem de execução).
 * @param {{ level: string, intent: string }} c
 * @param {{ levelHint?: 'pos'|'grad'|null, intentHint?: 'preco'|'info'|'mista'|null }} hints
 * @returns {Array<{ rpc: string, source: 'pos_info'|'pos_preco'|'grad_info'|'grad_preco' }>}
 */
export function planKnowledgeRpcs(c, hints = {}) {
  let { level, intent } = c
  if (hints.levelHint === 'pos' || hints.levelHint === 'grad') {
    level = hints.levelHint
  }
  if (hints.intentHint === 'preco' || hints.intentHint === 'info' || hints.intentHint === 'mista') {
    intent = hints.intentHint
  }

  const rpc = (name, source) => ({ rpc: name, source })

  if (level === 'ambiguous') {
    return [
      rpc('match_pos_info', 'pos_info'),
      rpc('match_pos_preco', 'pos_preco'),
      rpc('match_grad_info', 'grad_info'),
      rpc('match_grad_preco', 'grad_preco'),
    ]
  }

  if (level === 'pos') {
    if (intent === 'preco') return [rpc('match_pos_preco', 'pos_preco')]
    if (intent === 'info') return [rpc('match_pos_info', 'pos_info')]
    return [rpc('match_pos_info', 'pos_info'), rpc('match_pos_preco', 'pos_preco')]
  }

  // grad
  if (intent === 'preco') return [rpc('match_grad_preco', 'grad_preco')]
  if (intent === 'info') return [rpc('match_grad_info', 'grad_info')]
  return [rpc('match_grad_info', 'grad_info'), rpc('match_grad_preco', 'grad_preco')]
}
