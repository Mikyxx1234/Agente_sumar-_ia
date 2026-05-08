/**
 * OpenAI helpers: transcrição de áudio (Whisper) e análise de imagem (Vision).
 * Usa fetch nativo do Node (≥18) — sem dependências extras.
 *
 * Áudio  → POST /v1/audio/transcriptions (whisper-1), input multipart.
 * Imagem → POST /v1/chat/completions     (gpt-4o-mini), content image_url data-URL.
 */

import { resolveModel } from '../ai/modelRegistry.js'

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
const CHAT_URL = 'https://api.openai.com/v1/chat/completions'

// Prompt antigo era "Analise essa imagem e resuma pra mim o que ela é"
// — genérico demais. Pra atendimento comercial educacional, o lead
// costuma mandar foto de notas ENEM, histórico escolar, boletim, RG,
// captura de outro chat. O orquestrador precisa do CONTEÚDO TEXTUAL
// (notas, datas, valores) pra responder; uma descrição visual genérica
// faz a IA não saber o que fazer e ficar muda.
const DEFAULT_IMAGE_PROMPT = `Você está ajudando um atendente comercial de uma faculdade brasileira a entender uma imagem que um lead enviou pelo WhatsApp.

TAREFAS (em ordem):
1. CLASSIFIQUE o tipo da imagem: notas/boletim do ENEM, histórico escolar, declaração/diploma, RG/CNH, comprovante de residência, captura de tela de outra conversa, foto pessoal, captura de site, ou outro.
2. EXTRAIA todo texto legível literalmente, preservando os números. Cole tudo em formato fácil de ler. Se houver tabela (ex.: notas ENEM por matéria), use formato "Matéria: Nota".
3. Se for documento educacional (ENEM, histórico, boletim), além das notas, registre o ano da prova/curso, nome do candidato e pontuação total/média se visíveis.
4. Se for screenshot de outro chat, transcreva as mensagens preservando quem falou.
5. Se NÃO houver texto legível ou a imagem estiver muito borrada, descreva o que está visível e diga que a leitura ficou parcial.

RESPONDA em português, em texto corrido, em até 8 linhas, com TUDO que o atendente precisa pra continuar o atendimento. NÃO use JSON, listas com bullets ou markdown. Comece a resposta com "[IMAGEM RECEBIDA - <tipo>]: " seguido do conteúdo extraído.`

function b64ToBuffer(b64) {
  if (!b64 || typeof b64 !== 'string') throw new Error('Base64 ausente ou inválido')
  const clean = b64.replace(/^data:[^;]+;base64,/, '')
  return Buffer.from(clean, 'base64')
}

function requireApiKey(env) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  return apiKey
}

export async function transcribeAudioBase64(env, b64, opts = {}) {
  const apiKey = requireApiKey(env)
  const buf = b64ToBuffer(b64)
  const model = opts.model || resolveModel(env, 'transcribe')
  const filename = opts.filename || 'file.ogg'
  const mimeType = opts.mimeType || 'audio/ogg'

  const form = new FormData()
  form.append('file', new Blob([buf], { type: mimeType }), filename)
  form.append('model', model)
  if (opts.language) form.append('language', opts.language)

  const res = await fetch(TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI transcribe ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  const text = typeof data?.text === 'string' ? data.text.trim() : ''
  return text
}

export async function analyzeImageBase64(env, b64, opts = {}) {
  const apiKey = requireApiKey(env)
  const model = opts.model || resolveModel(env, 'vision')
  const prompt = opts.prompt || DEFAULT_IMAGE_PROMPT
  // WhatsApp manda quase sempre JPEG. PNG era default antigo e funcionava
  // por sorte (a OpenAI tolera mismatch leve), mas é mais seguro o real.
  const mimeType = opts.mimeType || 'image/jpeg'

  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '')
  if (!clean) throw new Error('Imagem base64 ausente')
  const dataUrl = `data:${mimeType};base64,${clean}`

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            // detail: 'high' melhora OCR de texto pequeno (notas ENEM têm
            // tabela densa). Custo ~3x do padrão mas vale pra documentos.
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
      max_tokens: 1200,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI vision ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.map((p) => p?.text || '').join(' ').trim()
  }
  return ''
}
