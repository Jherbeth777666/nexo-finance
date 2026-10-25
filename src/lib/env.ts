/**
 * Variáveis públicas do frontend. Apenas chaves com prefixo VITE_ chegam ao navegador,
 * e somente as que são seguras para expor (URL e chave "anon" do Supabase, protegidas por RLS).
 */
export const env = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
}

export function isSupabaseConfigured(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey)
}
