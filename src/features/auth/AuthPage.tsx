import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Logo } from '@/components/icons'
import { Button, ButtonLink, Field, Input, Notice } from '@/components/ui'
import { AuthError, useAuth } from './session'
import { readPendingInvite } from '@/features/invites/pendingInvite'
import { validateEmail, validateLogin, validateSignup, type AuthErrors, type SignupInput } from './validation'

type Mode = 'login' | 'signup' | 'forgot'

export default function AuthPage({ mode: initial }: { mode: 'login' | 'signup' }) {
  const auth = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>(initial)
  const [form, setForm] = useState<SignupInput>({ name: '', company: '', email: '', password: '', confirm: '' })
  const [errors, setErrors] = useState<AuthErrors>({})
  const [notice, setNotice] = useState<{ tone: 'warn' | 'risk' | 'pos'; title: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const disabled = auth.status === 'disabled'
  const pendingInvite = readPendingInvite()

  useEffect(() => setMode(initial), [initial])
  useEffect(() => {
    document.title = `${mode === 'signup' ? 'Criar conta' : mode === 'forgot' ? 'Recuperar acesso' : 'Entrar'} · Nexo Finance`
    setErrors({})
    setNotice(null)
  }, [mode])
  useEffect(() => {
    if (auth.status !== 'signed_in') return
    const token = readPendingInvite()
    navigate(token ? `/convite/${encodeURIComponent(token)}` : '/app/overview', { replace: true })
  }, [auth.status, navigate])

  const set = (k: keyof SignupInput) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value })
    setErrors({ ...errors, [k]: undefined })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setNotice(null)
    const errs: AuthErrors =
      mode === 'signup'
        ? validateSignup(form, { requiresCompany: !pendingInvite })
        : mode === 'login'
          ? validateLogin(form)
          : validateEmail(form.email)
            ? { email: validateEmail(form.email) }
            : {}
    setErrors(errs)
    if (Object.keys(errs).length) {
      document.getElementById(`auth-${Object.keys(errs)[0]}`)?.focus()
      return
    }
    if (disabled) {
      setNotice({ tone: 'warn', title: 'Contas ainda não disponíveis', text: 'O serviço de autenticação não está configurado neste ambiente. Nenhum dado foi enviado.' })
      return
    }
    setBusy(true)
    try {
      if (mode === 'login') {
        await auth.signIn(form.email, form.password)
      } else if (mode === 'signup') {
        const r = await auth.signUp({ ...form, company: pendingInvite ? '' : form.company })
        if (r === 'confirm_email')
          setNotice({
            tone: 'pos',
            title: 'Confirme seu e-mail',
            text: `Enviamos um link para ${form.email}. Depois de confirmar, entre para ${pendingInvite ? 'aceitar o convite' : 'concluir a criação da empresa'}.`,
          })
      } else {
        await auth.requestPasswordReset(form.email)
        setNotice({ tone: 'pos', title: 'Verifique seu e-mail', text: 'Se houver uma conta com este e-mail, você receberá um link para redefinir a senha.' })
      }
    } catch (err) {
      setNotice({ tone: 'risk', title: 'Não foi possível continuar', text: err instanceof AuthError ? err.message : 'Erro inesperado. Tente novamente.' })
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'signup' ? 'Criar conta' : mode === 'forgot' ? 'Recuperar acesso' : 'Entrar'

  return (
    <div className="flex min-h-screen bg-bg">
      <div className="flex w-full flex-col justify-center px-4 py-10 sm:px-10 lg:w-[520px]">
        <Link to="/" className="mb-10 flex items-center gap-2.5" aria-label="Nexo Finance — página inicial">
          <Logo />
          <span className="font-semibold tracking-tight">
            Nexo <span className="font-normal text-ink-2">Finance</span>
          </span>
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-ink-2">
          {mode === 'signup' ? (
            <>
              Já tem conta?{' '}
              <Link to="/login" className="link">
                Entrar
              </Link>
            </>
          ) : mode === 'login' ? (
            <>
              Ainda não tem conta?{' '}
              <Link to="/cadastro" className="link">
                Criar conta
              </Link>
            </>
          ) : (
            'Informe o e-mail da sua conta para receber um link de redefinição.'
          )}
        </p>

        <form onSubmit={submit} noValidate className="mt-8 space-y-4">
          {mode === 'signup' && (
            <>
              <Field label="Seu nome" htmlFor="auth-name" error={errors.name}>
                <Input id="auth-name" autoComplete="name" value={form.name} invalid={!!errors.name} onChange={set('name')} />
              </Field>
              {!pendingInvite && (
                <Field label="Nome da empresa" htmlFor="auth-company" error={errors.company}>
                  <Input id="auth-company" autoComplete="organization" value={form.company} invalid={!!errors.company} onChange={set('company')} />
                </Field>
              )}
            </>
          )}
          <Field label="E-mail" htmlFor="auth-email" error={errors.email}>
            <Input id="auth-email" type="email" autoComplete="email" value={form.email} invalid={!!errors.email} onChange={set('email')} />
          </Field>
          {mode !== 'forgot' && (
            <Field label="Senha" htmlFor="auth-password" error={errors.password} hint={mode === 'signup' ? 'Ao menos 10 caracteres, com letras e números' : undefined}>
              <Input
                id="auth-password"
                type="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                value={form.password}
                invalid={!!errors.password}
                onChange={set('password')}
              />
            </Field>
          )}
          {mode === 'signup' && (
            <Field label="Confirmar senha" htmlFor="auth-confirm" error={errors.confirm}>
              <Input id="auth-confirm" type="password" autoComplete="new-password" value={form.confirm} invalid={!!errors.confirm} onChange={set('confirm')} />
            </Field>
          )}
          {mode === 'login' && (
            <button type="button" className="link text-xs" onClick={() => setMode('forgot')}>
              Esqueci minha senha
            </button>
          )}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            {mode === 'forgot' ? 'Enviar link' : title}
          </Button>
          {mode === 'forgot' && (
            <button type="button" className="link text-xs" onClick={() => setMode('login')}>
              Voltar para entrar
            </button>
          )}
        </form>

        {notice && (
          <Notice tone={notice.tone} title={notice.title} className="mt-5">
            {notice.text}
            {disabled && (
              <div className="mt-3">
                <ButtonLink to="/app/overview?modo=demo" size="sm" variant="secondary">
                  Abrir demonstração
                </ButtonLink>
              </div>
            )}
          </Notice>
        )}
        {mode === 'signup' && <p className="mt-6 text-xs text-ink-3">Guardamos apenas nome, e-mail e os dados financeiros que você registrar. Seus dados não são usados para treinar modelos de IA.</p>}
      </div>
      <aside className="hidden flex-1 items-center border-l border-line-soft bg-surface px-16 lg:flex">
        <div className="max-w-md">
          <p className="eyebrow mb-3">Nexo Finance</p>
          <p className="text-2xl leading-snug font-semibold tracking-tight">Veja o que vem antes do problema.</p>
          <ul className="mt-6 space-y-3 text-sm text-ink-2">
            <li>— Saldo, contas a pagar e a receber em uma leitura só.</li>
            <li>— Projeção de caixa com premissas que você pode conferir.</li>
            <li>— Alertas com evidências e os lançamentos que os sustentam.</li>
          </ul>
        </div>
      </aside>
    </div>
  )
}
