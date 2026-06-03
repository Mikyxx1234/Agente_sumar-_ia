/**
 * Parser do retorno do Meta Flow (WhatsApp Cloud API — `nfm_reply.response_json`).
 *
 * Porte fiel do node n8n "Code in JavaScript3" do workflow `log_inscricao_feita_sum`:
 * o agente passa a cumprir, sem n8n, a função de extrair e AJUSTAR os dados do
 * formulário (telefone, data, sexo, cpf) antes de gravar no card do Kommo.
 *
 * O webhook Meta entrega o reply no buffer como:
 *   `[FORMULARIO SUMAR]: {"TextInput_1475361_2":"...","TextInput_1475363_2":"..."}`
 * (ver server/whatsapp/metaWebhook.js).
 *
 * Mapeamento por field_id embutido na chave (`<Tipo>_<fieldId>_<idx>`) — mais
 * resiliente que casar a string literal inteira (tolera mudança de tipo/índice):
 *   1475361 → nome | 1475363 → cpf | 1475397 → telefone
 *   1475395 → email | 1475971 → sexo (enum) | 1475467 → data de nascimento
 */

const FIELD_ID_TO_SLOT = {
  1475361: 'nome',
  1475363: 'cpf',
  1475397: 'telefone',
  1475395: 'email',
  1475971: 'sexo_enum',
  1475467: 'data_nasc',
}

// enum_id → rótulo (Dropdown de sexo do Flow). O n8n só tinha Masculino mapeado;
// os demais ficam pendentes até termos os enum_ids. Sexo não é campo obrigatório.
const SEXO_ENUM_MAP = {
  1194759: 'Masculino',
  // 1194761: 'Feminino',
  // 1194763: 'Outro',
}

function onlyDigits(v) {
  return String(v ?? '').replace(/\D/g, '')
}

/** Normaliza data para DD/MM/AAAA (aceita DD/MM/AAAA, ISO AAAA-MM-DD e 8 dígitos). */
export function formatDateToDDMMYYYY(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`
  const digits = s.replace(/\D/g, '')
  if (digits.length === 8) {
    const dd = digits.slice(0, 2)
    const mm = digits.slice(2, 4)
    const yyyy = digits.slice(4, 8)
    const d = Number(dd)
    const m = Number(mm)
    const y = Number(yyyy)
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
      return `${dd}/${mm}/${yyyy}`
    }
  }
  return s
}

/** Adiciona o DDI 55 quando vier só DDD+número (10 ou 11 dígitos). */
export function normalizeBrazilPhone(v) {
  const digits = onlyDigits(v)
  if (!digits) return null
  if (digits.startsWith('55')) return digits
  if (digits.length === 10 || digits.length === 11) return `55${digits}`
  return digits
}

function mapSexo(enumId) {
  return SEXO_ENUM_MAP[String(enumId)] ?? null
}

function cleanStr(v) {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * Extrai a string JSON do conteúdo do buffer/marcador e devolve o objeto.
 * Aceita o marcador `[FORMULARIO SUMAR]: {...}`, JSON cru, ou um objeto já parseado.
 */
export function extractMetaFlowResponseObject(input) {
  if (input && typeof input === 'object') return input
  const raw = String(input ?? '')
  if (!raw.trim()) return null
  // pega o primeiro bloco {...} do texto (após o marcador, se houver)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const slice = raw.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch {
    return null
  }
}

/** Heurística: o texto contém um retorno de Meta Flow (nfm_reply / response_json / TextInput_<id>). */
export function messageIsMetaFlowFormReply(input) {
  if (input && typeof input === 'object') {
    return Object.keys(input).some((k) => /^(?:[A-Za-z]+_)?\d{6,}(?:_\d+)?$/.test(k))
  }
  const raw = String(input ?? '')
  if (!raw) return false
  if (/\bnfm_reply\b/i.test(raw) || /\bresponse_json\b/i.test(raw)) return true
  if (/\b(?:TextInput|Dropdown|DatePicker|RadioButtonsGroup|CheckboxGroup)_\d{6,}/i.test(raw)) return true
  return false
}

/**
 * Faz o parse + ajuste dos dados do Meta Flow.
 *
 * @param {string|object} input texto do buffer (`[FORMULARIO SUMAR]: {...}`) ou objeto.
 * @returns {{ok:true, nome_completo, cpf, telefone, telefone_normalizado, email, sexo, sexo_enum_id, data_nascimento, raw} | {ok:false, error:string}}
 */
export function parseMetaFlowResponseJson(input) {
  const data = extractMetaFlowResponseObject(input)
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'response_json_ausente_ou_invalido' }
  }

  const slots = {}
  for (const [key, value] of Object.entries(data)) {
    const m = String(key).match(/(\d{6,})/)
    if (!m) continue
    const slot = FIELD_ID_TO_SLOT[Number(m[1])]
    if (slot && slots[slot] === undefined) slots[slot] = value
  }

  const nome = cleanStr(slots.nome)
  const cpf = cleanStr(slots.cpf)
  const telefone = cleanStr(slots.telefone)
  const email = cleanStr(slots.email)
  const sexoEnumId = cleanStr(slots.sexo_enum)
  const dataNasc = cleanStr(slots.data_nasc)

  // Sem nenhum dado-chave reconhecido, não é um formulário útil.
  if (!nome && !cpf && !telefone && !email && !dataNasc) {
    return { ok: false, error: 'nenhum_campo_reconhecido', raw: data }
  }

  return {
    ok: true,
    pattern: 'meta_flow_nfm_reply_147',
    nome_completo: nome,
    cpf,
    cpf_digits: cpf ? onlyDigits(cpf) : null,
    telefone,
    telefone_normalizado: normalizeBrazilPhone(telefone),
    email,
    sexo: mapSexo(sexoEnumId),
    sexo_enum_id: sexoEnumId,
    data_nascimento: formatDateToDDMMYYYY(dataNasc),
    raw: data,
  }
}
