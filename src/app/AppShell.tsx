import { Suspense, useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router'
import { DataProvider, useStore } from '@/data/store'
import { DemoRepository } from '@/data/demoRepository'
import { SupabaseRepository } from '@/data/supabaseRepository'
import type { FinanceRepository } from '@/data/repository'
import { useAuth } from '@/features/auth/session'
import { readPendingInvite } from '@/features/invites/pendingInvite'
import { Onboarding } from './Onboarding'
import { Icon, Logo, type IconName } from '@/components/icons'
import { Button, EmptyState, Tag, cx } from '@/components/ui'
import { formatDateBR } from '@/lib/dates'
import { PageFallback } from './PageFallback'

export const NAV: { to: string; label: string; short: string; icon: IconName }[] = [
  { to: '/app/overview', label: 'Visão geral', short: 'Visão', icon: 'overview' },
  { to: '/app/movimentacoes', label: 'Movimentações', short: 'Lançam.', icon: 'list' },
  { to: '/app/fluxo-de-caixa', label: 'Fluxo de caixa', short: 'Caixa', icon: 'flow' },
  { to: '/app/inteligencia', label: 'Inteligência financeira', short: 'Alertas', icon: 'signal' },
  { to: '/app/simulador', label: 'Simulador', short: 'Simular', icon: 'sliders' },
  { to: '/app/relatorios', label: 'Relatórios', short: 'Relat.', icon: 'report' },
  { to: '/app/importacoes', label: 'Importações', short: 'Importar', icon: 'upload' },
  { to: '/app/configuracoes', label: 'Configurações', short: 'Config.', icon: 'settings' },
]

const MODE_KEY = 'nexo.mode'
const readDemoPref = () => {
  try {
    return sessionStorage.getItem(MODE_KEY) === 'demo'
  } catch {
    return false
  }
}

/**
 * Escolhe a origem dos dados: empresa real (usuário autenticado) ou demonstração.
 * Os dois nunca se misturam: repositórios diferentes, armazenamentos diferentes.
 */
export default function AppShell() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [demoPref, setDemoPref] = useState(readDemoPref)

  useEffect(() => {
    if (params.get('modo') !== 'demo') return
    try {
      sessionStorage.setItem(MODE_KEY, 'demo')
    } catch {
      /* preferência apenas */
    }
    setDemoPref(true)
    params.delete('modo')
    setParams(params, { replace: true })
  }, [params, setParams])

  // Convite pendente tem prioridade: aceitar antes de entrar na empresa/onboarding.
  useEffect(() => {
    if (auth.status !== 'signed_in' || demoPref) return
    const token = readPendingInvite()
    if (token) navigate(`/convite/${encodeURIComponent(token)}`, { replace: true })
  }, [auth.status, demoPref, navigate])

  const live = auth.status === 'signed_in' && !demoPref
  const membership = auth.memberships.find((m) => m.companyId === auth.activeCompanyId) ?? null
  const repoKey = live ? `live:${membership?.companyId ?? 'none'}` : 'demo'
  const repo = useMemo<FinanceRepository | null>(
    () => (live ? (membership && auth.client ? new SupabaseRepository(auth.client, membership.companyId, membership.role) : null) : new DemoRepository()),
    // Um repositório por empresa/modo; recriar só quando a chave muda.
    [repoKey, auth.client],
  )

  const exitDemo = () => {
    try {
      sessionStorage.removeItem(MODE_KEY)
    } catch {
      /* preferência apenas */
    }
    setDemoPref(false)
  }

  if (auth.status === 'loading') return <PageFallback full />
  if (live && auth.memberships.length === 0) return <Onboarding />
  if (!repo) return <PageFallback full />

  return (
    <DataProvider key={repoKey} repository={repo}>
      <Shell onExitDemo={auth.status === 'signed_in' && demoPref ? exitDemo : undefined} />
    </DataProvider>
  )
}

function Shell({ onExitDemo }: { onExitDemo?: () => void }) {
  const auth = useAuth()
  const { status, today, persistent, reload } = useStore()
  const [drawer, setDrawer] = useState(false)
  const location = useLocation()
  useEffect(() => setDrawer(false), [location.pathname])
  useEffect(() => {
    const current = NAV.find((n) => location.pathname.startsWith(n.to))
    document.title = current ? `${current.label} · Nexo Finance` : 'Nexo Finance'
  }, [location.pathname])

  const company = status.kind === 'ready' ? status.data.company : null

  return (
    <div className="min-h-screen bg-bg">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface-3 focus:px-3 focus:py-2">
        Pular para o conteúdo
      </a>

      {/* Navegação lateral (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-line-soft bg-[#0d1015] lg:flex">
        <SidebarContent onExitDemo={onExitDemo} />
      </aside>

      {/* Gaveta (tablet/móvel) */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button className="absolute inset-0 bg-black/60" aria-label="Fechar menu" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-[264px] flex-col border-r border-line-soft bg-[#0d1015]">
            <SidebarContent onClose={() => setDrawer(false)} onExitDemo={onExitDemo} />
          </aside>
        </div>
      )}

      <div className="lg:pl-[232px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line-soft bg-bg/90 px-4 backdrop-blur-sm sm:px-6">
          <button className="-ml-1 rounded p-1.5 text-ink-2 hover:bg-surface-2 lg:hidden" aria-label="Abrir menu" onClick={() => setDrawer(true)}>
            <Icon name="menu" />
          </button>
          <Link to="/app/overview" className="lg:hidden" aria-label="Nexo Finance — visão geral">
            <Logo size={24} />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            {!company?.isDemo && auth.memberships.length > 1 ? (
              <select
                aria-label="Empresa ativa"
                value={auth.activeCompanyId ?? ''}
                onChange={(e) => auth.setActiveCompany(e.target.value)}
                className="max-w-56 truncate rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink"
              >
                {auth.memberships.map((m) => (
                  <option key={m.companyId} value={m.companyId}>
                    {m.companyName}
                  </option>
                ))}
              </select>
            ) : (
              <span className="truncate text-sm font-medium text-ink">{company?.name ?? '—'}</span>
            )}
            {company?.isDemo && <Tag tone="warn">Demonstração</Tag>}
            {company?.role === 'viewer' && <Tag>Somente leitura</Tag>}
            {onExitDemo && (
              <button onClick={onExitDemo} className="link hidden text-xs whitespace-nowrap sm:inline">
                Voltar para minha empresa
              </button>
            )}
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs text-ink-3">
            <span className="hidden items-center gap-1.5 sm:inline-flex">
              <Icon name="calendar" size={14} />
              Referência <span className="num text-ink-2">{formatDateBR(today)}</span>
            </span>
          </div>
        </header>

        {company?.isDemo && (
          <div className="border-b border-warn/15 bg-warn-soft px-4 py-1.5 text-center text-xs text-warn/90 sm:px-6">
            Modo de demonstração: empresa e lançamentos fictícios, salvos apenas neste navegador
            {!persistent && ' (armazenamento bloqueado — alterações serão perdidas ao recarregar)'}.
          </div>
        )}

        <main id="conteudo" className="mx-auto max-w-[1280px] px-4 pt-6 pb-28 sm:px-6 lg:pb-12">
          {status.kind === 'loading' && <PageFallback />}
          {status.kind === 'error' && (
            <EmptyState title="Não foi possível carregar os dados" icon="alert" action={<Button onClick={reload}>Tentar novamente</Button>}>
              {status.message}
            </EmptyState>
          )}
          {status.kind === 'ready' && (
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          )}
        </main>
      </div>

      {/* Barra inferior (móvel) */}
      <nav aria-label="Navegação principal" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line-soft bg-[#0d1015]/95 backdrop-blur-sm lg:hidden">
        {NAV.slice(0, 4).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            className={({ isActive }) => cx('flex flex-col items-center gap-1 py-2.5 text-[10.5px]', isActive ? 'text-ink' : 'text-ink-3')}
          >
            <Icon name={n.icon} size={19} />
            {n.short}
          </NavLink>
        ))}
        <button onClick={() => setDrawer(true)} className="flex flex-col items-center gap-1 py-2.5 text-[10.5px] text-ink-3">
          <Icon name="more" size={19} />
          Mais
        </button>
      </nav>
    </div>
  )
}

function SidebarContent({ onClose, onExitDemo }: { onClose?: () => void; onExitDemo?: () => void }) {
  const auth = useAuth()
  return (
    <>
      <div className="flex h-14 items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5" aria-label="Nexo Finance — página inicial">
          <Logo size={26} />
          <span className="text-[15px] font-semibold tracking-tight">
            Nexo <span className="font-normal text-ink-2">Finance</span>
          </span>
        </Link>
        {onClose && (
          <button onClick={onClose} className="rounded p-1 text-ink-3 hover:text-ink" aria-label="Fechar menu">
            <Icon name="close" />
          </button>
        )}
      </div>
      <nav aria-label="Seções" className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-0.5">
          {NAV.map((n, i) => (
            <li key={n.to}>
              {i === 5 && <div className="mx-2 my-3 border-t border-line-soft" />}
              <NavLink
                to={n.to}
                className={({ isActive }) =>
                  cx(
                    'group relative flex items-center gap-3 rounded-md px-2.5 py-2 text-[13.5px] transition-colors',
                    isActive ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface hover:text-ink',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-ink" />}
                    <Icon name={n.icon} className={isActive ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2'} />
                    {n.label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-line-soft px-4 py-3 text-xs text-ink-3">
        {auth.status === 'signed_in' ? (
          <>
            <p className="truncate text-ink-2" title={auth.user?.email}>
              {auth.user?.email}
            </p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {onExitDemo ? (
                <button onClick={onExitDemo} className="link">
                  Minha empresa
                </button>
              ) : (
                <Link to="/app/overview?modo=demo" className="link">
                  Ver demonstração
                </Link>
              )}
              <button onClick={() => auth.signOut()} className="link">
                Sair
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-ink-2">Visitante</p>
            <p>Sem conta conectada</p>
            <Link to="/login" className="link mt-1 inline-block">
              Entrar
            </Link>
          </>
        )}
      </div>
    </>
  )
}
