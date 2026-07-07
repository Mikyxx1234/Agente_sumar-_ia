/**
 * Validação do campo curso_inscricao antes da API Captação Sumaré.
 * Evita polo gravado como curso, textos de anúncio Meta e nomes fora do catálogo.
 */

import { SUMARE_POLOS_EAD } from './sumarePoloCatalog.js'
import { resolveCursoOfertaFromDb } from '../server/sumareCaptacaoCursoStore.js'

const POLO_NAME_KEYS = new Set(
  SUMARE_POLOS_EAD.flatMap((p) => [p.nome, ...p.aliases, p.id.replace(/_/g, ' ')]).map((s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .trim(),
  ),
)

const GARBAGE_CURSO_RES = [
  /^voc[eê]\s+gostaria/i,
  /^quero\s+mais\s+inform/i,
  /^gradua[cç][aã]o$/i,
  /^p[oó]s(\s|-|$)/i,
  /^iniciar\s+atendimento/i,
  /^em\s+atendimento$/i,
  /^whatsapp$/i,
  /^voc[eê]\s+gostaria\s+de\s+conhecer/i,
  /^curso\s+de\s+interesse$/i,
  /^n[aã]o\s+informado/i,
]

function normKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Nome de polo EAD gravado erroneamente no campo curso. */
export function isPoloNameMisplacedAsCurso(curso) {
  const k = normKey(curso)
  if (!k) return false
  return POLO_NAME_KEYS.has(k)
}

/** Texto claramente inválido como nome de curso. */
export function isGarbageCursoInscricao(curso) {
  const raw = String(curso || '').trim()
  if (!raw) return true
  const k = normKey(raw)
  if (GARBAGE_CURSO_RES.some((re) => re.test(k) || re.test(raw))) return true
  if (isPoloNameMisplacedAsCurso(raw)) return true
  return false
}

/**
 * @param {object} snapshot
 * @param {object} env
 */
export async function analyzeCursoInscricaoSnapshot(snapshot, env = process.env) {
  const curso = String(snapshot?.curso_inscricao || '').trim()
  if (!curso) {
    return { ok: false, code: 'CURSO_AUSENTE', reason: 'Curso da inscrição não informado', missing: ['curso'] }
  }
  if (isGarbageCursoInscricao(curso)) {
    return {
      ok: false,
      code: 'CURSO_INVALIDO_SNAPSHOT',
      reason: `Curso inválido no formulário: "${curso}"`,
      missing: ['curso'],
    }
  }
  const oferta = await resolveCursoOfertaFromDb(curso, env)
  if (!oferta?.codigo) {
    return {
      ok: false,
      code: 'CURSO_NAO_RESOLVIDO',
      reason: `Curso não encontrado no catálogo Sumaré: "${curso}"`,
      missing: ['curso'],
    }
  }
  return { ok: true, resolvedCurso: oferta.curso_nome || curso, codigo: oferta.codigo }
}
