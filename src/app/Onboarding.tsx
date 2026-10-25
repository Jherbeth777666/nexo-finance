import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Logo } from '@/components/icons'
import { Button, Field, Input, Notice } from '@/components/ui'
import { AuthError, useAuth } from '@/features/auth/session'
import { readPendingInvite } from '@/features/invites/pendingInvite'
import { parseMoney } from '@/lib/money'

/** Usuário autenticado sem empresa: cria a primeira (a função do banco cria dono, conta e categorias). */
export function Onboarding() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('nexo.pendingCompany') ?? ''
    } catch {
      return ''
    }
  })
  const [balance, setBalance] = useState('')
  const [errors, setErrors] = useState<{ name?: string; balance?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)

  // Quem chegou por convite não deve criar uma empresa antes de aceitar o convite.
  useEffect(() => {
    const token = readPendingInvite()
    if (token) navigate(`/convite/${encodeURIComponent(token)}`, { replace: true })
  }, [navigate])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs: typeof errors = {}
    if (name.trim().length < 2 || name.trim().length > 120) errs.name = 'Use de 2 a 120 caracteres'
    const cents = balance.trim() ? parseMoney(balance) : 0
    if (cents === null) errs.balance = 'Valor inválido. Ex.: 12.500,00'
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true)
    try {
      await auth.createCompany(name, (cents ?? 0) / 100)
    } catch (err) {
      setErrors({ form: err instanceof AuthError ? err.message : 'Não foi possível criar a empresa.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo />
          <span className="font-semibold">Nexo Finance</span>
        </div>
        <p className="eyebrow mb-2">Primeiro acesso</p>
        <h1 className="text-2xl font-semibold tracking-tight">Cadastre sua empresa</h1>
        <p className="mt-1 text-sm text-ink-2">Criamos uma conta principal e categorias básicas. Você pode ajustar tudo depois.</p>
        <form onSubmit={submit} noValidate className="mt-6 space-y-4">
          <Field label="Nome da empresa" htmlFor="ob-name" error={errors.name}>
            <Input id="ob-name" value={name} maxLength={120} invalid={!!errors.name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Saldo atual da conta principal (R$)" htmlFor="ob-balance" error={errors.balance} hint="Ponto de partida rastreável do saldo e das projeções. Pode ser zero.">
            <Input id="ob-balance" inputMode="decimal" className="num" placeholder="0,00" value={balance} invalid={!!errors.balance} onChange={(e) => setBalance(e.target.value)} />
          </Field>
          {errors.form && <Notice tone="risk">{errors.form}</Notice>}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Criar empresa
          </Button>
        </form>
        <p className="mt-6 text-xs text-ink-3">
          Prefere explorar antes?{' '}
          <Link to="/app/overview?modo=demo" className="link">
            Abrir demonstração
          </Link>{' '}
          ·{' '}
          <button className="link" onClick={() => auth.signOut()}>
            Sair
          </button>
        </p>
      </div>
    </div>
  )
}
