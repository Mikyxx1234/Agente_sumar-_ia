/**
 * Nome da instância Evolution (env) e aliases da instância antiga (migração).
 */

function parseLegacyAliases(env) {
  const raw = String(env.EVOLUTION_INSTANCE_LEGACY || '').trim()
  const fromEnv = raw
    ? raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)
    : []
  // Sem aliases embutidos: o projeto usa apenas a instância configurada em
  // EVOLUTION_INSTANCE (SUMARE_IA), resolvida por comparação case-insensitive.
  // Instâncias antigas/duplicadas no Evolution não são referenciadas aqui —
  // se algum dia precisar mapear um webhook legado, use EVOLUTION_INSTANCE_LEGACY.
  return [...new Set(fromEnv)]
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
