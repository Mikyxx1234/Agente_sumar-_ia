/**
 * Nome da instância Evolution (env) e aliases da instância antiga (migração).
 */

function parseLegacyAliases(env) {
  const raw = String(env.EVOLUTION_INSTANCE_LEGACY || '').trim()
  const fromEnv = raw
    ? raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)
    : []
  const builtIn = [
    'Sumare Licenciado - Comercial',
    'sumare licenciado - comercial',
    'sumare_ia',
    'SUMARE IA ',
  ]
  return [...new Set([...fromEnv, ...builtIn])]
}

export function getEvolutionInstanceName(env) {
  return String(env.EVOLUTION_INSTANCE || env.EVOLUTION_INSTANCE_NAME || '').trim() || null
}

/**
 * Normaliza o nome vindo do webhook para o configurado em EVOLUTION_INSTANCE.
 * Aceita aliases (instância antiga) e diferença só de maiúsculas (sumare_ia / SUMARE_IA).
 */
export function normalizeEvolutionInstance(env, rawInstance) {
  const configured = getEvolutionInstanceName(env)
  const raw = String(rawInstance || '').trim()
  if (!configured) return raw || null
  if (!raw) return configured
  if (raw.toLowerCase() === configured.toLowerCase()) return configured
  const aliases = parseLegacyAliases(env)
  if (aliases.some((a) => a.toLowerCase() === raw.toLowerCase())) return configured
  return raw
}
