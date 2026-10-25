import type { SupabaseClient } from '@supabase/supabase-js'
import { env, isSupabaseConfigured } from './env'

/**
 * Cliente Supabase carregado sob demanda: a landing e o modo de demonstração não baixam
 * o SDK (~45 KB gzip). Só a chave pública "anon" é usada aqui; o isolamento vem do RLS.
 */
export const AUTH_STORAGE_KEY = 'nexo.auth'

let client: Promise<SupabaseClient> | null = null

export function getSupabase(): Promise<SupabaseClient> {
  if (!isSupabaseConfigured()) return Promise.reject(new Error('Supabase não configurado'))
  client ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(env.supabaseUrl!, env.supabaseAnonKey!, {
      auth: { storageKey: AUTH_STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    }),
  )
  return client
}

/** Verificação barata (sem carregar o SDK) de que há uma sessão salva neste navegador. */
export function hasStoredSession(): boolean {
  try {
    return !!globalThis.localStorage?.getItem(AUTH_STORAGE_KEY)
  } catch {
    return false
  }
}
