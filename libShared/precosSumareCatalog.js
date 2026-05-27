/**
 * Catálogo oficial Sumaré (mensalidades) + helpers de content RAG (pos_preco / grad_preco).
 * Fontes: mg.sumare.edu.br/pos-graduacao/ead, pr.sumare.edu.br/graduacao/ead
 */

export const CATALOGO_POS = [
  ['Pós-Graduação em Psicopedagogia com Ênfase em Psicomotricidade', 187, 623.33],
  ['Pós-Graduação em Deficiência Auditiva (LIBRAS)', 187, 623.33],
  ['Pós-Graduação em Educação Infantil e Desenvolvimento da Linguagem', 187, 623.33],
  ['Pós-Graduação em Gestão Escolar com foco em Recursos Humanos', 187, 623.33],
  ['Pós-Graduação em Ensino Lúdico', 187, 623.33],
  ['Pós-Graduação em Administração de Empresas para Engenheiros', 227, 756.65],
  ['Pós-Graduação em Serviços e Sistemas de Saúde', 187, 623.33],
  ['MBA em Gestão Empresarial', 187, 747.5],
  ['MBA em Gestão de Projeto', 187, 623.33],
  ['MBA em Liderança e Gestão de Pessoas', 187, 623.33],
  ['MBA em Finanças Corporativas', 187, 623.33],
  ['MBA em Negócios e Vendas', 187, 623.33],
  ['MBA em Gestão da Qualidade', 187, 623.33],
  ['MBA em Operações e Logística', 187, 623.33],
  ['Pós-Graduação em Psicologia Organizacional e do Trabalho', 187, 623.33],
  ['Pós-Graduação em Fiscalização Urbana', 399, 997.5],
  ['Pós-graduação em Análise e Projeto de Sistemas', 187, 623.33],
  ['Pós-Graduação em Ciência de Dados', 187, 623.33],
  ['Pós-Graduação em Segurança da Informação', 187, 623.33],
]

export const CATALOGO_GRAD = [
  ['Educação Física - Licenciatura', 97, 323.33],
  ['Geografia', 87, 290],
  ['História', 87, 290],
  ['Letras Habilitação Língua Portuguesa', 87, 290],
  ['Matemática', 87, 290],
  ['Pedagogia', 97, 323.33],
  ['Arquitetura e Urbanismo', 187, 623.33],
  ['Engenharia Civil', 197, 656.66],
  ['Engenharia Elétrica', 197, 656.66],
  ['Engenharia Mecânica', 197, 656.66],
  ['Engenharia de Produção', 197, 656.66],
  ['Biomedicina', 197, 656.66],
  ['Educação Física - Bacharelado', 97, 323.33],
  ['Estética e Cosmética', 197, 656.66],
  ['Farmácia', 187, 623.33],
  ['Fisioterapia', 187, 623.33],
  ['Gastronomia', 87, 290],
  ['Nutrição', 197, 656.66],
  ['Radiologia', 187, 623.33],
  ['Superior em Serviço Social', 87, 290],
  ['Saneamento Ambiental', 57, 190],
  ['Administração', 107, 356.65],
  ['Ciências Contábeis', 107, 356.66],
  ['Ciências Econômicas', 97, 323.33],
  ['Gestão Ambiental', 57, 190],
  ['Gestão Comercial', 87, 290],
  ['Gestão Pública', 87, 290],
  ['Gestão Financeira', 87, 290],
  ['Gestão Hospitalar', 87, 290],
  ['Jornalismo', 87, 290],
  ['Logística', 97, 323.33],
  ['Marketing', 97, 323.33],
  ['Processos Gerenciais', 87, 290],
  ['Publicidade e Propaganda', 87, 290],
  ['Gestão de Recursos Humanos', 97, 323.33],
  ['Secretariado Executivo Bílingue', 77, 256.66],
  ['Gestão de Segurança Privada', 87, 290],
  ['Gestão de Qualidade', 87, 290],
  ['Análise e Desenvolvimento de Sistemas', 97, 323.33],
  ['Banco de Dados', 87, 290],
  ['Ciência da Computação', 97, 323.33],
  ['Gestão da Tecnologia da Informação', 87, 290],
  ['Redes de Computadores', 87, 290],
  ['Sistemas para Internet', 87, 290],
  ['Sistemas de Informação', 97, 323.33],
  ['Jogos Digitais', 87, 290],
]

/** Registros com colunas CSV deslocadas — reconstrução manual. */
export const CORRUPT_POS_REBUILD = {
  147: {
    chave: 'Pós-Graduação em Educação Digital | Tecnologias e Metodologias Ativas para o Ensino a DistânciaEAD',
    curso: 'Pós-Graduação em Educação Digital — Tecnologias e Metodologias Ativas para o Ensino a Distância',
    desc: 187,
    cheio: 623,
  },
  153: {
    chave: 'Pós-Graduação em Psicologia, Neurociências e ComportamentoEAD',
    curso: 'Pós-Graduação em Psicologia, Neurociências e Comportamento',
    desc: 187,
    cheio: 623,
  },
  158: {
    chave: 'MBA Executivo em Corporate Finance — Controller e Auditoria FinanceiraEAD',
    curso: 'MBA Executivo em Corporate Finance — Controller e Auditoria Financeira',
    desc: 187,
    cheio: 623,
  },
  161: {
    chave: 'MBA Gestão Comercial — Negociação e Inteligência de MercadoEAD',
    curso: 'MBA Gestão Comercial — Negociação e Inteligência de Mercado',
    desc: 187,
    cheio: 623,
  },
  164: {
    chave: 'MBA em Logística — Lean Supply Chain e Gestão Estratégica de ComprasEAD',
    curso: 'MBA em Logística — Lean Supply Chain e Gestão Estratégica de Compras',
    desc: 187,
    cheio: 623,
  },
}

export function normName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\bead\b/g, '')
    .replace(/\bpos graduacao em\b/g, '')
    .replace(/\bpos graduacao\b/g, '')
    .replace(/\bmba em\b/g, 'mba ')
    .replace(/\bgraduacao\b/g, '')
    .replace(/\bnome curso\b/g, '')
    .replace(/\bbacharelado\b/g, '')
    .replace(/\btecnologo\b/g, '')
    .replace(/\blicenciatura\b/g, '')
    .trim()
}

export function priceInt(v) {
  const n = Number(String(v || '').replace(/[^\d.,]/g, '').replace(',', '.'))
  if (!Number.isFinite(n)) return null
  return Math.round(n)
}

export function findCatalogMatch(nome, catalog) {
  const n = normName(nome)
  let best = null
  let bestScore = 0
  for (const [curso, desc, cheio] of catalog) {
    const c = normName(curso)
    if (n === c || n.includes(c) || c.includes(n)) {
      return { curso, desc: priceInt(desc), cheio: priceInt(cheio), match: 'exato' }
    }
    const words = c.split(' ').filter((w) => w.length > 3)
    const score = words.filter((w) => n.includes(w)).length / Math.max(words.length, 1)
    if (score > bestScore && score >= 0.55) {
      bestScore = score
      best = { curso, desc: priceInt(desc), cheio: priceInt(cheio), match: `parcial(${Math.round(score * 100)}%)` }
    }
  }
  return best
}

export function parsePipeContent(content) {
  const s = String(content || '')
  const get = (label) => {
    const re = new RegExp(`${label}:\\s*([^|]+)`, 'i')
    const m = s.match(re)
    return m ? m[1].trim() : ''
  }
  if (/col7:/i.test(s)) {
    return {
      chave: get('chave'),
      curso: get('curso'),
      precoCheio: get('preco cheio'),
      precoDesconto: get('preco com desconto'),
      gradOuPos: get('grad ou pos'),
      corrupt: true,
    }
  }
  return {
    chave: get('chave'),
    curso: get('curso') || get('nome_curso'),
    precoCheio: get('preco cheio'),
    precoDesconto: get('preco com desconto'),
    gradOuPos: get('grad ou pos'),
    corrupt: false,
  }
}

/** Padrão legado em pos_preco: mensalidade em preco com desconto; grad ou pos repete o valor; col6=POS. */
export function buildPosPrecoContent({ chave, curso, precoCheio, precoDesconto }) {
  const m = priceInt(precoDesconto)
  const c = priceInt(precoCheio)
  return `chave: ${chave} | curso: ${curso} | preco cheio: ${c} | preco com desconto: ${m} | grad ou pos: ${m} | col6: POS`
}

export function buildGradPrecoContent({ chave, nomeCurso, precoCheio, precoDesconto }) {
  return `chave: ${chave} | nome_curso: ${nomeCurso} | preco cheio: ${priceInt(precoCheio)} | preco com desconto: ${priceInt(precoDesconto)} | grad ou pos: GRADUACAO`
}

export function resolvePosPrices(id, parsed) {
  const fix = CORRUPT_POS_REBUILD[id]
  if (fix) {
    return { desc: fix.desc, cheio: fix.cheio, chave: fix.chave, curso: fix.curso, source: 'corrupt_rebuild' }
  }

  const nome = parsed.curso || parsed.chave
  const cat = findCatalogMatch(nome, CATALOGO_POS)
  if (cat) {
    return { desc: cat.desc, cheio: cat.cheio, chave: parsed.chave, curso: parsed.curso || cat.curso, source: `catalog:${cat.match}` }
  }

  const extra = priceInt(parsed.gradOuPos)
  const wrongDesc = priceInt(parsed.precoDesconto)

  if (extra === 399) return { desc: 399, cheio: 998, chave: parsed.chave, curso: parsed.curso, source: 'tier_fiscalizacao' }
  if (extra === 227) return { desc: 227, cheio: 757, chave: parsed.chave, curso: parsed.curso, source: 'tier_engenheiros' }
  if (wrongDesc === 33 || wrongDesc === 65) {
    const cheio = extra === 191 ? 636 : priceInt(parsed.precoCheio) || 623
    return {
      desc: extra === 191 ? 187 : extra,
      cheio: extra === 191 ? 623 : cheio >= 700 && extra === 187 ? 748 : cheio >= 600 ? 623 : cheio,
      chave: parsed.chave,
      curso: parsed.curso,
      source: 'tier_fix_wrong_desc',
    }
  }

  return {
    desc: wrongDesc || extra,
    cheio: priceInt(parsed.precoCheio) || 623,
    chave: parsed.chave,
    curso: parsed.curso,
    source: 'unchanged',
  }
}

export function resolveGradPrices(parsed) {
  const nome = (parsed.curso || '').replace(/^Graduação - /i, '').trim() || parsed.chave
  const cat = findCatalogMatch(nome, CATALOGO_GRAD)
  if (cat) {
    return { desc: cat.desc, cheio: cat.cheio, chave: parsed.chave, nomeCurso: parsed.curso || `Graduação - ${cat.curso}`, source: `catalog:${cat.match}` }
  }
  return {
    desc: priceInt(parsed.precoDesconto),
    cheio: priceInt(parsed.precoCheio),
    chave: parsed.chave,
    nomeCurso: parsed.curso,
    source: 'unchanged',
  }
}
