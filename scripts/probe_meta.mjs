const token = process.env.WHATSAPP_ACCESS_TOKEN
const candidate = '794200977108142'
const v = process.env.WHATSAPP_API_VERSION || 'v21.0'
const H = { Authorization: `Bearer ${token}` }

async function probe(label, url) {
  const r = await fetch(url, { headers: H })
  const t = await r.text()
  console.log(`\n==== ${label} ====\nGET ${url}\n→ HTTP ${r.status}\n${t.slice(0, 600)}`)
}

await probe('verifica phone_number_id', `https://graph.facebook.com/${v}/${candidate}?fields=display_phone_number,verified_name,quality_rating,name_status,code_verification_status,id`)
