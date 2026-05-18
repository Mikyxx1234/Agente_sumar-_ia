import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const prompt = `Você é um classificador de escopo do atendimento da Faculdade Sumaré.

Sua função é analisar a mensagem do usuário e retornar apenas um JSON válido.

Considere DENTRO DO ESCOPO perguntas sobre:
- cursos da Faculdade Sumaré
- graduação
- pós-graduação
- MBA
- especialização
- modalidade
- duração
- grade curricular
- áreas de atuação
- mercado de trabalho relacionado ao curso
- valores, mensalidades, bolsas e descontos de cursos
- matrícula, inscrição e atendimento educacional

Considere FORA DO ESCOPO perguntas sobre:
- SQL
- programação
- banco de dados
- APIs
- tecnologia não relacionada a cursos
- planilhas
- assuntos pessoais
- política
- saúde
- direito
- notícias
- qualquer tema que não tenha relação com cursos ou matrícula da Faculdade Sumaré

Retorne somente um JSON neste formato:

{
  "dentro_escopo": true ou false,
  "categoria": "curso | preco | matricula | institucional | fora_escopo",
  "nivel": "graduacao | pos | indefinido",
  "motivo": "explicação curta"
}`

const node = {
  parameters: {
    promptType: 'define',
    options: { systemMessage: prompt },
  },
  id: 'f8e3a1b2-4c5d-6e7f-8a9b-0c1d2e3f4a5b',
  name: 'classificador',
  type: '@n8n/n8n-nodes-langchain.agent',
  typeVersion: 1.6,
  position: [0, 0],
}

const NL = '\r\n'
const NODE_BLOCK =
  ',' + NL + '    ' + JSON.stringify(node, null, 4).replace(/\n/g, NL + '    ')

function patchApagar(path) {
  let raw = readFileSync(path, 'utf8')
  if (raw.includes('"name": "classificador"')) {
    console.log(`[skip] classificador já existe em ${path}`)
    return
  }
  const marker = `${NL}  ],${NL}  "connections":`
  if (!raw.includes(marker)) throw new Error(`connections não encontrado em ${path}`)
  raw = raw.replace(marker, `${NODE_BLOCK}${NL}  ],${NL}  "connections":`)
  writeFileSync(path, raw, 'utf8')
  console.log(`[ok] classificador adicionado em ${path}`)
}

for (const rel of ['public/APAGAR.txt', 'APAGAR.txt']) {
  patchApagar(join(root, rel))
}
