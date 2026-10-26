/**
 * Origens permitidas das Edge Functions (variável ALLOWED_ORIGIN, separada por vírgula).
 * Comparação por igualdade exata; nunca "*". Lista vazia ou ausente falha fechada.
 */
export function parseAllowedOrigins(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o !== '' && o !== '*')
}

/** A origem do pedido, se estiver na lista; é a única que pode voltar em Access-Control-Allow-Origin. */
export function matchAllowedOrigin(allowed: readonly string[], origin: string | null): string | null {
  return origin && allowed.includes(origin) ? origin : null
}
