// Smoke test opcional da API Gemini (o job de feedback comercial voltou a usar OpenAI).
// Uso (PowerShell):
//   $env:GEMINI_API_KEY='...'; node scripts/testGemini.mjs

const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_MAPS_API_KEY
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
if (!key) {
  console.error('Defina GEMINI_API_KEY (ou GOOGLE_MAPS_API_KEY)')
  process.exit(1)
}

const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`
const body = {
  contents: [{ parts: [{ text: 'Avalie a frase "atendimento bom mas resposta lenta" e devolva JSON com chaves nota (0-10) e resumo (string curta).' }] }],
  generationConfig: {
    temperature: 0.3,
    maxOutputTokens: 200,
    responseMimeType: 'application/json',
    thinkingConfig: { thinkingBudget: 0 },
  },
}

console.log(`[testGemini] modelo=${model}`)
const t0 = Date.now()
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const ms = Date.now() - t0
const text = await res.text()
console.log(`[testGemini] status=${res.status} (${ms}ms)`)
if (!res.ok) {
  console.error(text.slice(0, 500))
  process.exit(2)
}
const data = JSON.parse(text)
const parts = data?.candidates?.[0]?.content?.parts || []
const content = parts.map((p) => p?.text || '').join('').trim()
console.log('[testGemini] content:', content)
console.log('[testGemini] usage:', JSON.stringify(data.usageMetadata || {}))
console.log('[testGemini] OK')
