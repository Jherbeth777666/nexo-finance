import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Logo } from '@/components/icons'
import { Button, Field, Input, Notice } from '@/components/ui'
import { getSupabase } from '@/lib/supabase'
import { isSupabaseConfigured } from '@/lib/env'
import { AuthError, useAuth } from './session'
import { validatePassword } from './validation'

/** Destino do link de recuperação: o SDK lê o token da URL e abre uma sessão de recuperação. */
export default function ResetPasswordPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [ready, setReady] = useState<'checking' | 'ok' | 'invalid'>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.title = 'Nova senha · Nexo Finance'
    if (!isSupabaseConfigured()) {
      setReady('invalid')
      return
    }
    let unsub: (() => void) | undefined
    getSupabase()
      .then(async (sb) => {
        const { data } = sb.auth.onAuthStateChange((event, session) => {
          if (event === 'PASSWORD_RECOVERY' || session) setReady('ok')
        })
        unsub = () => data.subscription.unsubscribe()
        const { data: s } = await sb.auth.getSession()
        setReady(s.session ? 'ok' : (r) => (r === 'ok' ? r : 'invalid'))
      })
      .catch(() => setReady('invalid'))
    return () => unsub?.()
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const pw = validatePassword(password)
    if (pw) return setError(pw)
    if (password !== confirm) return setError('As senhas não coincidem')
    setBusy(true)
    setError(null)
    try {
      await auth.updatePassword(password)
      navigate('/app/overview', { replace: true })
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Não foi possível alterar a senha.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 flex items-center gap-2.5" aria-label="Nexo Finance">
          <Logo />
          <span className="font-semibold">Nexo Finance</span>
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Definir nova senha</h1>
        {ready === 'checking' && <p className="mt-4 text-sm text-ink-3">Validando o link…</p>}
        {ready === 'invalid' && (
          <Notice tone="warn" title="Link inválido ou expirado" className="mt-5">
            Solicite um novo link em{' '}
            <Link to="/login" className="link">
              Entrar → Esqueci minha senha
            </Link>
            .
          </Notice>
        )}
        {ready === 'ok' && (
          <form onSubmit={submit} noValidate className="mt-6 space-y-4">
            <Field label="Nova senha" htmlFor="np" hint="Ao menos 10 caracteres, com letras e números" error={error ?? undefined}>
              <Input id="np" type="password" autoComplete="new-password" value={password} invalid={!!error} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Confirmar nova senha" htmlFor="np2">
              <Input id="np2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              Salvar nova senha
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
