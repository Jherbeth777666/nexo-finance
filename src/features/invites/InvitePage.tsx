import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Logo } from '@/components/icons'
import { ButtonLink, Notice } from '@/components/ui'
import { PageFallback } from '@/app/PageFallback'
import { friendlyDbError } from '@/data/supabaseMapping'
import { useAuth } from '@/features/auth/session'
import { clearPendingInvite, readPendingInvite, savePendingInvite } from './pendingInvite'

type Outcome = 'checking' | 'none' | 'auth' | 'demo' | 'error' | 'success'

/** Página pública do convite: guarda o token, troca a URL e aceita depois do login/cadastro. */
export default function InvitePage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const { token: routeToken } = useParams()
  const [outcome, setOutcome] = useState<Outcome>('checking')
  const [message, setMessage] = useState('')
  const tokenRef = useRef<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (routeToken) {
      savePendingInvite(routeToken)
      // O token não fica na barra de endereço: evita histórico, logs e compartilhamento acidental.
      navigate('/convite', { replace: true })
    }
  }, [routeToken, navigate])

  useEffect(() => {
    if (routeToken || auth.status === 'loading' || started.current) return
    tokenRef.current ??= readPendingInvite()
    const token = tokenRef.current
    if (!token) return setOutcome('none')
    if (token.startsWith('demo-')) {
      // Convite fictício não deve ficar pendente no navegador.
      clearPendingInvite()
      tokenRef.current = null
      return setOutcome('demo')
    }
    if (auth.status === 'disabled') return setOutcome('demo')
    if (auth.status === 'signed_out') return setOutcome('auth')
    if (auth.status !== 'signed_in') return

    started.current = true
    setOutcome('checking')
    const client = auth.client
    if (!client) {
      clearPendingInvite()
      setOutcome('error')
      setMessage('Não foi possível concluir o convite agora. Entre novamente para tentar.')
      return
    }
    void (async () => {
      try {
        const { data, error } = await client.rpc('accept_invite', { p_token: token })
        if (error) {
          clearPendingInvite()
          tokenRef.current = null
          setOutcome('error')
          setMessage(friendlyDbError(error))
          return
        }
        clearPendingInvite()
        tokenRef.current = null
        await auth.refreshMemberships()
        if (typeof data === 'string') auth.setActiveCompany(data)
        setOutcome('success')
        navigate('/app/overview', { replace: true })
      } catch {
        clearPendingInvite()
        tokenRef.current = null
        setOutcome('error')
        setMessage('Não foi possível conectar ao servidor. Tente novamente.')
      }
    })()
  }, [routeToken, auth, navigate])

  if (routeToken || outcome === 'checking') return <PageFallback full />

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 flex items-center gap-2.5" aria-label="Nexo Finance — página inicial">
          <Logo />
          <span className="font-semibold tracking-tight">
            Nexo <span className="font-normal text-ink-2">Finance</span>
          </span>
        </Link>

        {outcome === 'none' && (
          <>
            <p className="eyebrow mb-2">Convite</p>
            <h1 className="text-2xl font-semibold tracking-tight">Nenhum convite pendente</h1>
            <p className="mt-2 text-sm text-ink-2">Abra o link de convite que você recebeu para entrar na equipe de uma empresa.</p>
            <ButtonLink to="/app/overview" className="mt-6" variant="primary">
              Ir para o Nexo Finance
            </ButtonLink>
          </>
        )}

        {outcome === 'auth' && (
          <>
            <p className="eyebrow mb-2">Convite</p>
            <h1 className="text-2xl font-semibold tracking-tight">Você recebeu um convite</h1>
            <p className="mt-2 text-sm text-ink-2">
              Entre com o e-mail que recebeu o convite ou crie uma conta. Depois disso, você entra direto na equipe da empresa — sem criar uma empresa própria.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <ButtonLink to="/cadastro" variant="primary">
                Criar conta
              </ButtonLink>
              <ButtonLink to="/login">Já tenho conta</ButtonLink>
            </div>
          </>
        )}

        {outcome === 'demo' && (
          <>
            <p className="eyebrow mb-2">Convite</p>
            <h1 className="text-2xl font-semibold tracking-tight">Convite de demonstração</h1>
            <Notice tone="warn" className="mt-4">
              Este link é apenas ilustrativo. Convites de equipe funcionam somente com o Supabase configurado; no modo de demonstração nenhum convite é enviado ou aceito.
            </Notice>
            <ButtonLink to="/app/overview?modo=demo" className="mt-6" variant="primary">
              Abrir demonstração
            </ButtonLink>
          </>
        )}

        {outcome === 'error' && (
          <>
            <p className="eyebrow mb-2">Convite</p>
            <h1 className="text-2xl font-semibold tracking-tight">Não foi possível aceitar o convite</h1>
            <Notice tone="risk" className="mt-4">
              {message}
            </Notice>
            <p className="mt-4 text-sm text-ink-2">Peça um novo convite a quem administra a empresa ou entre com o e-mail correto.</p>
            <ButtonLink to="/app/overview" className="mt-6">
              Ir para o Nexo Finance
            </ButtonLink>
          </>
        )}

        {outcome === 'success' && (
          <>
            <p className="eyebrow mb-2">Convite</p>
            <h1 className="text-2xl font-semibold tracking-tight">Convite aceito</h1>
            <p className="mt-2 text-sm text-ink-2">Abrindo a empresa…</p>
          </>
        )}
      </div>
    </div>
  )
}
