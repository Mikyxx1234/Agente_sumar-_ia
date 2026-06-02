/**
 * Download de mídia direto da WhatsApp Cloud API (Meta) — sem Evolution.
 *
 * No webhook nativo da Meta, a mensagem de áudio/imagem/documento NÃO vem
 * com os bytes. Vem só um `media_id`. O fluxo oficial é em duas etapas:
 *
 *   1) GET https://graph.facebook.com/<ver>/<media_id>
 *      Authorization: Bearer <token>
 *      → { url, mime_type, file_size, id, sha256 }
 *
 *   2) GET <url>  (a URL é temporária e exige o MESMO Bearer)
 *      → bytes binários da mídia
 *
 * Devolve base64 para reaproveitar transcribeAudioBase64 / analyzeImageBase64
 * (Whisper / Vision) — exatamente os mesmos usados no caminho Evolution.
 *
 * Envs (mesmas do envio Cloud — não precisa de credencial nova):
 *   WHATSAPP_ACCESS_TOKEN   token Meta/WABA
 *   WHATSAPP_API_VERSION    opcional, default v19.0
 */

function getConfig(env) {
  return {
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v19.0',
  }
}

/**
 * Baixa a mídia da Cloud API e devolve em base64.
 * @returns {Promise<{ok:boolean, base64?:string, mimeType?:string, code?:string, status?:number, error?:string, elapsedMs?:number}>}
 */
export async function fetchMetaMediaBase64(env, mediaId) {
  const started = Date.now()
  const cfg = getConfig(env)
  if (!cfg.accessToken) {
    return { ok: false, code: 'WHATSAPP_NOT_CONFIGURED', error: 'WHATSAPP_ACCESS_TOKEN ausente' }
  }
  const id = String(mediaId || '').trim()
  if (!id) return { ok: false, code: 'MISSING_MEDIA_ID', error: 'media_id vazio' }

  try {
    // Etapa 1: resolve a URL temporária da mídia.
    const metaRes = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
    })
    const metaRaw = await metaRes.text()
    let meta = null
    try { meta = metaRaw ? JSON.parse(metaRaw) : null } catch { meta = null }
    if (!metaRes.ok || !meta?.url) {
      return {
        ok: false,
        code: 'META_MEDIA_LOOKUP_FAILED',
        status: metaRes.status,
        error: typeof metaRaw === 'string' ? metaRaw.slice(0, 400) : 'sem url',
        elapsedMs: Date.now() - started,
      }
    }

    // Etapa 2: baixa os bytes (a URL exige o mesmo Bearer).
    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
    })
    if (!binRes.ok) {
      const errText = await binRes.text().catch(() => '')
      return {
        ok: false,
        code: 'META_MEDIA_DOWNLOAD_FAILED',
        status: binRes.status,
        error: errText.slice(0, 400),
        elapsedMs: Date.now() - started,
      }
    }
    const buf = Buffer.from(await binRes.arrayBuffer())
    return {
      ok: true,
      base64: buf.toString('base64'),
      mimeType: meta.mime_type || binRes.headers.get('content-type') || '',
      elapsedMs: Date.now() - started,
    }
  } catch (e) {
    return { ok: false, code: 'META_MEDIA_FETCH_EXCEPTION', error: e.message, elapsedMs: Date.now() - started }
  }
}
