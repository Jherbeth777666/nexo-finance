import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import type { MemberRole } from '@/domain/types'
import { isSupabaseConfigured } from '@/lib/env'
import { getSupabase, hasStoredSession } from '@/lib/supabase'
import { friendlyDbError } from '@/data/supabaseMapping'

/**
 * Sessão do usuário (Supabase Auth). Sem sessão salva, o SDK nem é baixado.
 * O modo de demonstração continua disponível para quem está ou não autenticado.
 */
export interface Membership {
  companyId: string
  companyName: string
  role: MemberRole
}

type AuthStatus = 'disabled' | 'loading' | 'signed_out' | 'signed_in'

interface AuthValue {
  status: AuthStatus
  user: User | null
  memberships: Membership[]
  activeCompanyId: string | null
  setActiveCompany: (id: string) => void
  client: SupabaseClient | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (p: { email: string; password: string; name: string; company?: string }) => Promise<'signed_in' | 'confirm_email'>
  signOut: () => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  updatePassword: (password: string) => Promise<void>
  createCompany: (name: string, openingBalance?: number) => Promise<string>
  refreshMemberships: () => Promise<void>
}

export class AuthError extends Error {}

const Ctx = createContext<AuthValue | null>(null)
const ACTIVE_KEY = 'nexo.activeCompany'

function authMessage(e: { message?: string; code?: string; status?: number } | null): string {
  const m = e?.message ?? ''
  if (/invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.'
  if (/email not confirmed/i.test(m)) return 'Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.'
  if (/already registered|already been registered|user_already_exists/i.test(m + (e?.code ?? ''))) return 'Já existe uma conta com este e-mail.'
  if (/rate limit|too many/i.test(m) || e?.status === 429) return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
  if (/password/i.test(m) && /(weak|short|least|characters)/i.test(m)) return 'Senha fraca: use ao menos 10 caracteres com letras e números.'
  if (/fetch|network/i.test(m)) return 'Não foi possível conectar ao servidor. Verifique sua conexão.'
  return 'Não foi possível concluir. Tente novamente.'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isSupabaseConfigured()
  const [status, setStatus] = useState<AuthStatus>(configured ? (hasStoredSession() ? 'loading' : 'signed_out') : 'disabled')
  const [client, setClient] = useState<SupabaseClient | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [activeCompanyId, setActive] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_KEY)
    } catch {
      return null
    }
  })

  const loadMemberships = useCallback(async (sb: SupabaseClient, u: User | null) => {
    if (!u) {
      setMemberships([])
      return
    }
    const { data, error } = await sb.from('company_members').select('company_id, role, companies(name)').eq('user_id', u.id)
    if (error) throw new AuthError(friendlyDbError(error))
    const list = (data as unknown as { company_id: string; role: MemberRole; companies: { name: string } | null }[]).map((m) => ({
      companyId: m.company_id,
      companyName: m.companies?.name ?? 'Empresa',
      role: m.role,
    }))
    setMemberships(list)
  }, [])

  // Carrega o SDK apenas se houver sessão salva; caso contrário, só quando o usuário agir.
  const ensureClient = useCallback(async () => {
    const sb = await getSupabase()
    setClient(sb)
    return sb
  }, [])

  useEffect(() => {
    if (!configured || status !== 'loading') return
    let unsub: (() => void) | undefined
    let cancelled = false
    ensureClient()
      .then(async (sb) => {
        const { data } = await sb.auth.getSession()
        const u = data.session?.user ?? null
        await loadMemberships(sb, u).catch(() => setMemberships([]))
        if (cancelled) return
        setUser(u)
        setStatus(u ? 'signed_in' : 'signed_out')
        const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
          if (event === 'SIGNED_OUT') {
            setUser(null)
            setMemberships([])
            setStatus('signed_out')
          } else if (session?.user && (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED')) {
            setUser(session.user)
            setStatus('signed_in')
          }
        })
        unsub = () => sub.subscription.unsubscribe()
      })
      .catch(() => !cancelled && setStatus('signed_out'))
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [configured])

  const setActiveCompany = useCallback((id: string) => {
    setActive(id)
    try {
      localStorage.setItem(ACTIVE_KEY, id)
    } catch {
      /* preferência apenas */
    }
  }, [])

  const value = useMemo<AuthValue>(() => {
    const requireConfigured = () => {
      if (!configured) throw new AuthError('O serviço de autenticação não está configurado neste ambiente.')
    }
    return {
      status,
      user,
      memberships,
      activeCompanyId: memberships.some((m) => m.companyId === activeCompanyId) ? activeCompanyId : (memberships[0]?.companyId ?? null),
      setActiveCompany,
      client,
      async signIn(email, password) {
        requireConfigured()
        const sb = await ensureClient()
        const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password })
        if (error) throw new AuthError(authMessage(error))
        await loadMemberships(sb, data.user)
        setUser(data.user)
        setStatus('signed_in')
      },
      async signUp({ email, password, name, company }) {
        requireConfigured()
        const sb = await ensureClient()
        const desiredCompany = company?.trim() ?? ''
        const { data, error } = await sb.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: name.trim() }, emailRedirectTo: `${location.origin}/login` },
        })
        if (error) throw new AuthError(authMessage(error))
        // Com confirmação de e-mail ativa, não há sessão: a empresa é criada no primeiro acesso.
        if (!data.session) {
          if (desiredCompany) {
            try {
              localStorage.setItem('nexo.pendingCompany', desiredCompany)
            } catch {
              /* opcional */
            }
          } else {
            try {
              localStorage.removeItem('nexo.pendingCompany')
            } catch {
              /* opcional */
            }
          }
          return 'confirm_email'
        }
        // Convidado não cria empresa: o vínculo vem do aceite do convite.
        let companyId: string | null = null
        if (desiredCompany) {
          const { data: id, error: e2 } = await sb.rpc('create_company', { p_name: desiredCompany })
          if (e2) throw new AuthError(friendlyDbError(e2))
          companyId = id as string
        }
        setUser(data.user)
        await loadMemberships(sb, data.user)
        if (companyId) setActiveCompany(companyId)
        setStatus('signed_in')
        return 'signed_in'
      },
      async signOut() {
        if (!client) return
        await client.auth.signOut()
        setUser(null)
        setMemberships([])
        setStatus('signed_out')
      },
      async requestPasswordReset(email) {
        requireConfigured()
        const sb = await ensureClient()
        const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${location.origin}/redefinir-senha` })
        // Mesmo resultado para e-mail existente ou não: não revela quem tem conta.
        if (error && (error.status === 429 || /rate/i.test(error.message))) throw new AuthError(authMessage(error))
      },
      async updatePassword(password) {
        requireConfigured()
        const sb = await ensureClient()
        const { data, error } = await sb.auth.updateUser({ password })
        if (error) throw new AuthError(authMessage(error))
        // A sessão de recuperação vira uma sessão normal.
        await loadMemberships(sb, data.user)
        setUser(data.user)
        setStatus('signed_in')
      },
      async createCompany(name, openingBalance = 0) {
        requireConfigured()
        const sb = await ensureClient()
        const { data, error } = await sb.rpc('create_company', { p_name: name.trim(), p_opening_balance: openingBalance })
        if (error) throw new AuthError(friendlyDbError(error))
        const { data: u } = await sb.auth.getUser()
        await loadMemberships(sb, u.user)
        setActiveCompany(data as string)
        try {
          localStorage.removeItem('nexo.pendingCompany')
        } catch {
          /* opcional */
        }
        return data as string
      },
      async refreshMemberships() {
        if (client) await loadMemberships(client, user)
      },
    }
  }, [status, user, memberships, activeCompanyId, setActiveCompany, client, configured, ensureClient, loadMemberships])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth fora do AuthProvider')
  return v
}
