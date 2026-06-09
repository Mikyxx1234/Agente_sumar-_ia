import fs from 'node:fs'
import PDFDocument from 'pdfkit'

const DEFAULT_FONT =
  process.platform === 'win32'
    ? 'C:/Windows/Fonts/arial.ttf'
    : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

function resolveFont() {
  if (fs.existsSync(DEFAULT_FONT)) return DEFAULT_FONT
  return null
}

/**
 * Gera PDF da grade curricular (buffer + metadados).
 * @param {{ cursoNome: string, modalidade: string, titulacao?: string, duracao?: string, investimento?: string, codigo?: string, intro?: string, disciplinas: string[], url?: string }} input
 * @returns {Promise<{ buffer: Buffer, fileName: string }>}
 */
export async function generateGradePdf(input) {
  const {
    cursoNome = 'Curso',
    modalidade = '',
    titulacao = 'Licenciatura',
    duracao = '8 semestres',
    investimento = '',
    codigo = '',
    intro = '',
    disciplinas = [],
    url = 'https://sumare.edu.br',
  } = input

  const slug = `${String(cursoNome).toLowerCase().replace(/\s+/g, '-')}-${String(modalidade).toLowerCase().replace(/\s+/g, '-')}`
  const fileName = `grade-${slug}.pdf`

  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true })
  const chunks = []
  doc.on('data', (c) => chunks.push(c))

  const fontPath = resolveFont()
  if (fontPath) doc.font(fontPath)
  else doc.font('Helvetica')

  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  const accent = '#1a3a6b'
  const muted = '#555555'

  doc.fillColor(accent).fontSize(11).text('SUMARÉ CENTRO UNIVERSITÁRIO', { align: 'left' })
  doc.moveDown(0.4)
  doc.fontSize(20).text('Grade curricular', { align: 'left' })
  doc.moveDown(0.2)
  doc.fontSize(16).text(cursoNome, { align: 'left' })
  doc.moveDown(0.6)

  doc.fillColor(muted).fontSize(10)
  doc.text(`Modalidade: ${modalidade}  ·  ${titulacao}`)
  doc.text(`Duração: ${duracao}${investimento ? `  ·  Investimento: ${investimento}` : ''}`)
  doc.text(`Total de disciplinas: ${disciplinas.length}${codigo ? `  ·  Código: ${codigo}` : ''}`)
  doc.moveDown(0.8)

  doc.fillColor(accent).fontSize(12).text('O que você vai aprender')
  doc.moveDown(0.3)
  if (intro) {
    doc.fillColor(muted).fontSize(9).text(intro, { align: 'justify' })
    doc.moveDown(0.6)
  }

  doc.fillColor('#000000').fontSize(10)
  const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2 - 12
  const leftX = doc.page.margins.left
  const rightX = leftX + colWidth + 24
  const startY = doc.y
  const half = Math.ceil(disciplinas.length / 2)

  function writeColumn(items, startIndex, x, yStart) {
    let y = yStart
    doc.x = x
    doc.y = y
    for (let i = 0; i < items.length; i++) {
      const line = `${String(startIndex + i + 1).padStart(2, '0')}. ${items[i]}`
      const h = doc.heightOfString(line, { width: colWidth })
      if (y + h > doc.page.height - doc.page.margins.bottom - 40) {
        doc.addPage()
        if (fontPath) doc.font(fontPath)
        y = doc.page.margins.top
      }
      doc.fillColor('#000000').fontSize(10).text(line, x, y, { width: colWidth })
      y += h + 4
    }
    return y
  }

  const leftItems = disciplinas.slice(0, half)
  const rightItems = disciplinas.slice(half)
  const yAfterLeft = writeColumn(leftItems, 0, leftX, startY)
  writeColumn(rightItems, half, rightX, startY)
  doc.y = Math.max(yAfterLeft, doc.y)

  doc.moveDown(1.2)
  if (doc.y > doc.page.height - doc.page.margins.bottom - 50) doc.addPage()
  doc.fillColor(muted).fontSize(8)
  doc.text(`Fonte oficial: ${url}`, { align: 'left' })
  doc.text(
    'Documento informativo. A matriz curricular pode ser atualizada conforme normas do MEC e deliberações internas.',
    { align: 'left' },
  )

  doc.end()
  const buffer = await done
  return { buffer, fileName }
}
