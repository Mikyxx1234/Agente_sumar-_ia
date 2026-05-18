/**
 * Ajustes do export n8n (APAGAR.txt) para a operação Faculdade Sumaré.
 * Aplicado em runtime no promptsLoader — não exige reexportar o JSON do n8n.
 */

/** Prompt auxiliar (escopo JSON) — visível no dashboard, não entra no system do orquestrador. */
export function isClassifierPromptNode(nodeName) {
  return String(nodeName || '').toLowerCase().trim() === 'classificador'
}

export function isLocationAgentNode(nodeName, body) {
  const n = String(nodeName || '').toLowerCase()
  const b = String(body || '').slice(0, 400).toLowerCase()
  if (/localiza/.test(n) && /agente/.test(n)) return true
  if (b.includes('agente de localização') || b.includes('agente localização')) return true
  if (b.includes('sua única função é processar dados de localização')) return true
  if (b.includes('encontrar o polo mais próximo')) return true
  return false
}

/** Substitui marcas legadas e alinha modalidade ao catálogo Sumaré (somente EAD nas unidades). */
export function sanitizePromptBody(body) {
  let t = String(body || '')
  const reps = [
    [/Universidade\s+Cruzeiro\s+do\s+Sul/gi, 'Faculdade Sumaré'],
    [/Cruzeiro\s+do\s+Sul\s+Virtual/gi, 'Faculdade Sumaré'],
    [/Cruzeiro\s+Virtual/gi, 'Faculdade Sumaré'],
    [/Cruzeiro\s+do\s+Sul/gi, 'Faculdade Sumaré'],
    [/\bSOEAD\b/gi, 'Faculdade Sumaré'],
    [/\bAnhanguera\b/gi, 'Faculdade Sumaré'],
    [/POSTGRES\s*-\s*AGENTE\s+COMERCIAL\s+CRUZEIRO/gi, 'AGENTE COMERCIAL SUMARÉ'],
    [/buscar_documentos3/gi, 'buscar_precos'],
    [/buscar_informacoes1/gi, 'buscar_informacoes'],
    [/docs_pos/gi, 'buscar_pos'],
  ]
  for (const [re, to] of reps) t = t.replace(re, to)

  // Modalidade: catálogo legado → comunicar só EAD (sem apagar negações tipo "não oferece presencial").
  t = t.replace(/semi-?\s*presencial/gi, 'EAD')
  t = t.replace(/modalidade[:\s]+presencial\b/gi, 'modalidade: EAD')
  t = t.replace(/cursos?\s+presenciais?/gi, 'cursos EAD')
  t = t.replace(/oferta\s+presencial/gi, 'oferta EAD')

  return t
}
