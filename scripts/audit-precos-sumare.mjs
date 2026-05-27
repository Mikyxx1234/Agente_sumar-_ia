/**
 * Auditoria de preços — site oficial Sumaré vs Supabase (pos_preco / grad_preco).
 * Gera planilha CSV para revisão antes de qualquer UPDATE no banco.
 *
 * Fontes oficiais (consultadas em 2026-05-27):
 *   Pós:    https://mg.sumare.edu.br/pos-graduacao/ead
 *   Grad:   https://pr.sumare.edu.br/graduacao/ead
 *   Página exemplo: sumare.edu.br/posGraduacao/.../ead-psicopedagogia-e-psicomotricidade
 *
 * Uso: node scripts/audit-precos-sumare.mjs
 *      node --env-file=.env scripts/audit-precos-sumare.mjs
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const outDir = path.join(root, 'data')

function loadEnv() {
  const env = { ...process.env }
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return env
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!k || env[k]) continue
    env[k] = line.slice(i + 1).trim()
  }
  return env
}

function parsePipeContent(content) {
  const s = String(content || '')
  const get = (label) => {
    const re = new RegExp(`${label}:\\s*([^|]+)`, 'i')
    const m = s.match(re)
    return m ? m[1].trim() : ''
  }
  const hasCol7 = /col7:/i.test(s)
  if (hasCol7) {
    return {
      chave: get('chave'),
      curso: get('curso'),
      precoCheio: get('preco cheio'),
      precoDesconto: get('preco com desconto'),
      gradOuPos: get('grad ou pos'),
      col6: get('col6'),
      col7: get('col7'),
      col8: get('col8'),
      corrupt: true,
    }
  }
  return {
    chave: get('chave'),
    curso: get('curso') || get('nome_curso'),
    precoCheio: get('preco cheio'),
    precoDesconto: get('preco com desconto'),
    gradOuPos: get('grad ou pos'),
    col6: get('col6'),
    corrupt: false,
  }
}

function normName(s) {
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
    .replace(/\bbacharelado\b/g, '')
    .replace(/\btecnologo\b/g, '')
    .replace(/\blicenciatura\b/g, '')
    .trim()
}

function parseMoney(v) {
  const n = Number(String(v || '').replace(/[^\d.,]/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function moneyClose(a, b, tol = 2) {
  const x = parseMoney(a)
  const y = parseMoney(b)
  if (x == null || y == null) return false
  return Math.abs(x - y) <= tol
}

/** Catálogo oficial extraído das páginas de listagem (valores mensais em R$). */
const CATALOGO_POS = [
  ['Pós-Graduação em Psicopedagogia com Ênfase em Psicomotricidade', 187, 623.33, 6],
  ['Pós-Graduação em Deficiência Auditiva (LIBRAS)', 187, 623.33, 6],
  ['Pós-Graduação em Educação Infantil e Desenvolvimento da Linguagem', 187, 623.33, 6],
  ['Pós-Graduação em Gestão Escolar com foco em Recursos Humanos', 187, 623.33, 6],
  ['Pós-Graduação em Ensino Lúdico', 187, 623.33, 6],
  ['Pós-Graduação em Administração de Empresas para Engenheiros', 227, 756.65, 6],
  ['Pós-Graduação em Serviços e Sistemas de Saúde', 187, 623.33, 6],
  ['MBA em Gestão Empresarial', 187, 747.5, 6],
  ['MBA em Gestão de Projeto', 187, 623.33, 6],
  ['MBA em Liderança e Gestão de Pessoas', 187, 623.33, 6],
  ['MBA em Finanças Corporativas', 187, 623.33, 6],
  ['MBA em Negócios e Vendas', 187, 623.33, 6],
  ['MBA em Gestão da Qualidade', 187, 623.33, 6],
  ['MBA em Operações e Logística', 187, 623.33, 6],
  ['Pós-Graduação em Psicologia Organizacional e do Trabalho', 187, 623.33, 6],
  ['Pós-Graduação em Fiscalização Urbana', 399, 997.5, 6],
  ['Pós-graduação em Análise e Projeto de Sistemas', 187, 623.33, 6],
  ['Pós-Graduação em Ciência de Dados', 187, 623.33, 6],
  ['Pós-Graduação em Segurança da Informação', 187, 623.33, 6],
]

const CATALOGO_GRAD = [
  ['Educação Física - Licenciatura', 97, 323.33, 8],
  ['Geografia', 87, 290, 8],
  ['História', 87, 290, 8],
  ['Letras Habilitação Língua Portuguesa', 87, 290, 8],
  ['Matemática', 87, 290, 8],
  ['Pedagogia', 97, 323.33, 8],
  ['Arquitetura e Urbanismo', 187, 623.33, 8],
  ['Engenharia Civil', 197, 656.66, 8],
  ['Engenharia Elétrica', 197, 656.66, 8],
  ['Engenharia Mecânica', 197, 656.66, 8],
  ['Engenharia de Produção', 197, 656.66, 8],
  ['Biomedicina', 197, 656.66, 8],
  ['Educação Física - Bacharelado', 97, 323.33, 8],
  ['Estética e Cosmética', 197, 656.66, 8],
  ['Farmácia', 187, 623.33, 8],
  ['Fisioterapia', 187, 623.33, 8],
  ['Gastronomia', 87, 290, 8],
  ['Nutrição', 197, 656.66, 8],
  ['Radiologia', 187, 623.33, 8],
  ['Superior em Serviço Social', 87, 290, 8],
  ['Saneamento Ambiental', 57, 190, 8],
  ['Administração', 107, 356.65, 8],
  ['Ciências Contábeis', 107, 356.66, 8],
  ['Ciências Econômicas', 97, 323.33, 8],
  ['Gestão Ambiental', 57, 190, 8],
  ['Gestão Comercial', 87, 290, 8],
  ['Gestão Pública', 87, 290, 8],
  ['Gestão Financeira', 87, 290, 8],
  ['Gestão Hospitalar', 87, 290, 8],
  ['Jornalismo', 87, 290, 8],
  ['Logística', 97, 323.33, 8],
  ['Marketing', 97, 323.33, 8],
  ['Processos Gerenciais', 87, 290, 8],
  ['Publicidade e Propaganda', 87, 290, 8],
  ['Gestão de Recursos Humanos', 97, 323.33, 8],
  ['Secretariado Executivo Bílingue', 77, 256.66, 8],
  ['Gestão de Segurança Privada', 87, 290, 8],
  ['Gestão de Qualidade', 87, 290, 8],
  ['Análise e Desenvolvimento de Sistemas', 97, 323.33, 8],
  ['Banco de Dados', 87, 290, 8],
  ['Ciência da Computação', 97, 323.33, 8],
  ['Gestão da Tecnologia da Informação', 87, 290, 8],
  ['Redes de Computadores', 87, 290, 8],
  ['Sistemas para Internet', 87, 290, 8],
  ['Sistemas de Informação', 97, 323.33, 8],
  ['Jogos Digitais', 87, 290, 8],
]

function findCatalogMatch(nome, catalog) {
  const n = normName(nome)
  let best = null
  let bestScore = 0
  for (const [curso, desc, cheio, periodo] of catalog) {
    const c = normName(curso)
    if (n === c || n.includes(c) || c.includes(n)) {
      return { curso, desc, cheio, periodo, match: 'exato' }
    }
    const words = c.split(' ').filter((w) => w.length > 3)
    const score = words.filter((w) => n.includes(w)).length / Math.max(words.length, 1)
    if (score > bestScore && score >= 0.5) {
      bestScore = score
      best = { curso, desc, cheio, periodo, match: `parcial(${Math.round(score * 100)}%)` }
    }
  }
  return best
}

function csvEscape(v) {
  const s = String(v ?? '')
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function rowToCsv(cols) {
  return cols.map(csvEscape).join(',')
}

async function fetchSupabase(env, table) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || ''
  if (!url || !key) throw new Error('SUPABASE_URL/KEY ausentes')
  const r = await fetch(`${url}/rest/v1/${table}?select=id,content&order=id.asc&limit=500`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  if (!r.ok) throw new Error(`${table}: ${r.status}`)
  return await r.json()
}

function classifyRow(tipo, row, catalogMatch) {
  const p = parsePipeContent(row.content)
  const issues = []

  if (p.corrupt) issues.push('REGISTRO_CORROMPIDO(colunas deslocadas)')

  const dbDesc = p.precoDesconto
  const dbCheio = p.precoCheio
  const dbExtra = p.gradOuPos

  if (tipo === 'pos') {
    if (dbDesc === '33' || dbDesc === '65') {
      issues.push('preco_com_desconto_aparenta_coluna_errada')
    }
    if (dbExtra && !moneyClose(dbDesc, dbExtra) && moneyClose(dbExtra, catalogMatch?.desc)) {
      issues.push('valor_correto_parece_estar_em_grad_ou_pos')
    }
  }

  if (!catalogMatch) {
    issues.push('NAO_ENCONTRADO_NO_CATALOGO_OFICIAL')
    return { status: 'sem_match_site', issues }
  }

  const siteDesc = catalogMatch.desc
  const siteCheio = catalogMatch.cheio

  const descOkDb = moneyClose(dbDesc, siteDesc)
  const descOkExtra = moneyClose(dbExtra, siteDesc)
  const cheioOk = moneyClose(dbCheio, siteCheio, 3)

  if (tipo === 'pos' && !descOkDb && descOkExtra && cheioOk) {
    return { status: 'divergente_campo_desconto', issues: [...issues, 'atualizar_preco_com_desconto_de_grad_ou_pos'] }
  }
  if (!descOkDb && !descOkExtra) {
    issues.push(`desconto_db=${dbDesc}_extra=${dbExtra}_site=${siteDesc}`)
  }
  if (!cheioOk) {
    issues.push(`cheio_db=${dbCheio}_site=${siteCheio}`)
  }

  if (descOkDb && cheioOk) return { status: 'ok', issues }
  if (descOkExtra && !descOkDb) return { status: 'divergente_campo_desconto', issues }
  return { status: 'divergente', issues }
}

async function main() {
  const env = loadEnv()
  const pos = await fetchSupabase(env, 'pos_preco')
  const grad = await fetchSupabase(env, 'grad_preco')

  const header = [
    'tipo',
    'id_supabase',
    'curso_supabase',
    'chave_supabase',
    'periodo_site_meses',
    'preco_desconto_site_R$',
    'preco_cheio_site_R$',
    'preco_desconto_supabase_preco_com_desconto',
    'preco_cheio_supabase',
    'campo_grad_ou_pos_supabase',
    'match_catalogo',
    'status',
    'observacoes',
    'url_fonte',
  ]

  const rows = [rowToCsv(header)]
  const summary = { ok: 0, divergente: 0, divergente_campo: 0, sem_match: 0, corrupt: 0 }

  for (const r of pos) {
    const p = parsePipeContent(r.content)
    const nome = p.curso || p.chave
    const cat = findCatalogMatch(nome, CATALOGO_POS)
    const { status, issues } = classifyRow('pos', r, cat)
    if (p.corrupt) summary.corrupt += 1
    else if (status === 'ok') summary.ok += 1
    else if (status === 'divergente_campo_desconto') summary.divergente_campo += 1
    else if (status === 'sem_match_site') summary.sem_match += 1
    else summary.divergente += 1

    rows.push(
      rowToCsv([
        'pos',
        r.id,
        nome,
        p.chave,
        cat?.periodo ?? '',
        cat?.desc ?? '',
        cat?.cheio ?? '',
        p.precoDesconto,
        p.precoCheio,
        p.gradOuPos,
        cat ? `${cat.match}: ${cat.curso}` : '',
        status,
        issues.join('; '),
        'https://mg.sumare.edu.br/pos-graduacao/ead',
      ]),
    )
  }

  for (const r of grad) {
    const p = parsePipeContent(r.content)
    const nome = p.curso || p.chave
    const cat = findCatalogMatch(nome.replace(/^Graduação - /, ''), CATALOGO_GRAD)
    const { status, issues } = classifyRow('grad', r, cat)
    if (p.corrupt) summary.corrupt += 1
    else if (status === 'ok') summary.ok += 1
    else if (status === 'divergente_campo_desconto') summary.divergente_campo += 1
    else if (status === 'sem_match_site') summary.sem_match += 1
    else summary.divergente += 1

    rows.push(
      rowToCsv([
        'grad',
        r.id,
        nome,
        p.chave,
        cat?.periodo ?? '',
        cat?.desc ?? '',
        cat?.cheio ?? '',
        p.precoDesconto,
        p.precoCheio,
        p.gradOuPos,
        cat ? `${cat.match}: ${cat.curso}` : '',
        status,
        issues.join('; '),
        'https://pr.sumare.edu.br/graduacao/ead',
      ]),
    )
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const csvPath = path.join(outDir, 'auditoria-precos-sumare-2026-05-27.csv')
  fs.writeFileSync(csvPath, '\uFEFF' + rows.join('\n'), 'utf8')

  const mdPath = path.join(outDir, 'auditoria-precos-sumare-2026-05-27.md')
  const md = `# Auditoria de preços — Sumaré (site vs Supabase)

Data: 2026-05-27  
**Nenhuma alteração foi feita no Supabase** — apenas levantamento para revisão.

## Fontes oficiais

| Tipo | URL |
|------|-----|
| Pós-graduação EAD | https://mg.sumare.edu.br/pos-graduacao/ead |
| Graduação EAD | https://pr.sumare.edu.br/graduacao/ead |
| Exemplo (Psicopedagogia) | https://sumare.edu.br/posGraduacao/Educação/ead-psicopedagogia-e-psicomotricidade |

Valores do site = **mensalidade com desconto** (1º valor) e **mensalidade cheia** (2º valor).  
Pós EAD: período típico **6 meses** (6 parcelas). Graduação: **4 a 8 semestres** conforme curso.

## Resumo

| Métrica | Pós (\`pos_preco\`) | Grad (\`grad_preco\`) |
|---------|---------------------|----------------------|
| Total registros | ${pos.length} | ${grad.length} |
| OK (bate com site) | — ver CSV | — ver CSV |
| Divergente campo \`preco com desconto\` | ${summary.divergente_campo} (estimativa pós) | — |
| Sem match no catálogo listado | ${summary.sem_match} | ${summary.sem_match} |
| Registro corrompido (colunas deslocadas) | ${summary.corrupt} | — |

## Causa raiz (caso Psicopedagogia — imagens enviadas)

O agente respondeu **R$ 33,00** (desconto) porque o campo \`preco com desconto\` no Supabase está **33**, enquanto o site e o campo \`grad ou pos\` no mesmo registro trazem **187**.

| Campo | Supabase (id 124) | Site oficial |
|-------|-------------------|--------------|
| preco com desconto | **33** ❌ | **187** |
| preco cheio | 623 | **623,33** |
| grad ou pos | **187** ✓ (valor real) | — |

Padrão repetido na maioria dos registros de pós: \`preco com desconto\` = 33 ou 65, e o valor mensal correto aparece em \`grad ou pos\`.

## Arquivo para revisão

- Planilha: \`data/auditoria-precos-sumare-2026-05-27.csv\` (UTF-8 com BOM — abre direto no Excel)

## Próximo passo (após sua aprovação)

1. Corrigir \`preco com desconto\` ← valor de \`grad ou pos\` (ou do site) onde aplicável  
2. Reindexar embeddings (\`content\` + vetor) nas tabelas \`pos_preco\` / \`grad_preco\`  
3. Validar cursos sem match no catálogo (pós extras fora da página MG) em páginas individuais sumare.edu.br
`
  fs.writeFileSync(mdPath, md, 'utf8')

  console.log(JSON.stringify({ csvPath, mdPath, summary, posCount: pos.length, gradCount: grad.length }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
