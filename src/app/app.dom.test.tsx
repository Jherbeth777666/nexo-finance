// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { App } from '@/App'
import { DemoRepository } from '@/data/demoRepository'
import { DataProvider, useStore } from '@/data/store'
import type { FinanceRepository } from '@/data/repository'
import { ToastProvider } from '@/components/overlay'
import { AuthProvider } from '@/features/auth/session'
import SettingsPage from '@/features/settings/SettingsPage'
import { accountBalances } from '@/domain/finance/metrics'
import type { MemberRole } from '@/domain/types'
import { formatBRL } from '@/lib/money'
import { validateLogin, validateSignup } from '@/features/auth/validation'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.scrollTo = () => {}
  // jsdom não implementa <dialog>.showModal
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})
beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )

class RoleRepository extends DemoRepository {
  constructor(private role: MemberRole) {
    super(null)
  }
  async load() {
    const snap = await super.load()
    return { ...snap, company: { ...snap.company, isDemo: false, role: this.role } }
  }
}

const renderSettings = (repository?: FinanceRepository) =>
  render(
    <AuthProvider>
      <ToastProvider>
        <DataProvider repository={repository ?? new DemoRepository(null)}>
          <MemoryRouter>
            <ReadySettings />
          </MemoryRouter>
        </DataProvider>
      </ToastProvider>
    </AuthProvider>,
  )

function ReadySettings() {
  const { status } = useStore()
  return status.kind === 'ready' ? <SettingsPage /> : null
}

describe('navegação', () => {
  it('abre a visão geral com as quatro áreas da central de decisões', async () => {
    renderAt('/app/overview')
    expect(await screen.findByRole('heading', { name: 'Situação financeira' }, { timeout: 5000 })).toBeTruthy()
    expect(screen.getByText('O que merece atenção')).toBeTruthy()
    expect(screen.getByText('Próxima decisão')).toBeTruthy()
    expect(screen.getByText('Evolução')).toBeTruthy()
    expect(screen.getAllByText('Demonstração').length).toBeGreaterThan(0)
  })

  it('navega pelo menu lateral', async () => {
    const user = userEvent.setup()
    renderAt('/app/overview')
    await screen.findByRole('heading', { name: 'Situação financeira' }, { timeout: 5000 })
    const nav = screen.getByRole('navigation', { name: 'Seções' })
    await user.click(within(nav).getByRole('link', { name: /Fluxo de caixa/ }))
    expect(await screen.findByRole('heading', { name: 'Para onde o caixa está indo' }, { timeout: 5000 })).toBeTruthy()
    await user.click(within(nav).getByRole('link', { name: /Simulador/ }))
    expect(await screen.findByRole('heading', { name: 'Teste antes de decidir' }, { timeout: 5000 })).toBeTruthy()
  })

  it('rota inexistente mostra página não encontrada', async () => {
    renderAt('/app/nao-existe')
    expect(await screen.findByText('Página não encontrada', {}, { timeout: 5000 })).toBeTruthy()
  })

  it('/app redireciona para a visão geral', async () => {
    renderAt('/app')
    expect(await screen.findByRole('heading', { name: 'Situação financeira' }, { timeout: 5000 })).toBeTruthy()
  })
})

describe('estados de erro', () => {
  it('falha ao carregar dados mostra mensagem e permite tentar de novo', async () => {
    const spy = vi.spyOn(DemoRepository.prototype, 'load').mockRejectedValueOnce(new Error('falha'))
    const user = userEvent.setup()
    renderAt('/app/overview')
    expect(await screen.findByText('Não foi possível carregar os dados', {}, { timeout: 5000 })).toBeTruthy()
    spy.mockRestore()
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByRole('heading', { name: 'Situação financeira' }, { timeout: 5000 })).toBeTruthy()
  })
})

describe('formulários', () => {
  it('novo lançamento valida campos e cria sem recarregar a página', async () => {
    const user = userEvent.setup()
    renderAt('/app/movimentacoes')
    await screen.findByRole('heading', { name: 'Lançamentos' }, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: /Novo lançamento/ }))
    await user.click(screen.getByRole('button', { name: 'Criar lançamento' }))
    expect(screen.getByText('Informe uma descrição')).toBeTruthy()
    expect(screen.getByText('Valor inválido. Ex.: 1.250,50')).toBeTruthy()
    await user.type(screen.getByLabelText('Descrição'), 'Compra de teste unitário')
    await user.type(screen.getByLabelText('Valor (R$)'), '99,90')
    await user.click(screen.getByRole('button', { name: 'Criar lançamento' }))
    await user.type(screen.getByLabelText('Buscar lançamentos'), 'teste unitário')
    expect(await screen.findByText('Compra de teste unitário', {}, { timeout: 2000 })).toBeTruthy()
    expect(screen.getByText('−R$ 99,90', { normalizer: (s) => s.replace(/\s/g, ' ') })).toBeTruthy()
  })

  it('login não simula sucesso sem serviço de autenticação', async () => {
    const user = userEvent.setup()
    renderAt('/login')
    await screen.findByRole('heading', { name: 'Entrar' }, { timeout: 5000 })
    await user.type(screen.getByLabelText('E-mail'), 'pessoa@exemplo.com')
    await user.type(screen.getByLabelText('Senha'), 'qualquer-coisa-1')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))
    expect(screen.getByText('Contas ainda não disponíveis')).toBeTruthy()
  })

  it('validação de cadastro', () => {
    expect(validateSignup({ name: '', company: '', email: 'x', password: 'curta', confirm: 'outra' })).toMatchObject({
      name: expect.any(String),
      company: expect.any(String),
      email: 'E-mail inválido',
      password: expect.any(String),
      confirm: 'As senhas não coincidem',
    })
    expect(validateSignup({ name: 'Ana', company: 'Loja', email: 'ana@loja.com.br', password: 'senhaforte123', confirm: 'senhaforte123' })).toEqual({}) // gitleaks:allow (senha fictícia de teste)
    expect(validateLogin({ email: '', password: '' })).toMatchObject({ email: 'Informe o e-mail', password: 'Informe a senha' })
  })
})

describe('configurações da empresa', () => {
  it('edita o nome da empresa no modo demonstração', async () => {
    const user = userEvent.setup()
    renderSettings()
    const input = await screen.findByLabelText('Nome da empresa')
    await user.clear(input)
    await user.type(input, 'Padaria Central')
    await user.click(screen.getByRole('button', { name: 'Salvar nome' }))
    expect(await screen.findByRole('heading', { name: 'Padaria Central' })).toBeTruthy()
  })

  it('mostra erro para nome curto', async () => {
    const user = userEvent.setup()
    renderSettings()
    const input = await screen.findByLabelText('Nome da empresa')
    await user.clear(input)
    await user.type(input, 'a')
    await user.click(screen.getByRole('button', { name: 'Salvar nome' }))
    expect(await screen.findByText('Use de 2 a 120 caracteres.')).toBeTruthy()
  })

  it('edita o saldo de abertura e o saldo exibido muda sem recarregar', async () => {
    const user = userEvent.setup()
    const repo = new DemoRepository(null)
    const snap = await repo.load()
    const account = snap.accounts[0]
    const before = accountBalances(snap.accounts, snap.transactions, snap.anchor).find((b) => b.account.id === account.id)!.balance
    const newOpening = 500_000
    renderSettings(repo)

    const input = await screen.findByLabelText(`Saldo de abertura de ${account.name} (R$)`)
    await user.clear(input)
    await user.type(input, '5000,00')
    await user.click(screen.getByRole('button', { name: `Salvar saldo de abertura de ${account.name}` }))

    const expected = before - account.openingBalance + newOpening
    const normalized = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ')
    await waitFor(() => {
      const row = screen.getByText(account.name).closest('li')!
      expect(normalized(row.textContent)).toContain(normalized(formatBRL(expected)))
      expect(normalized(row.textContent)).toContain(normalized(formatBRL(newOpening)))
    })
  })

  it('mostra erro para saldo inválido', async () => {
    const user = userEvent.setup()
    const repo = new DemoRepository(null)
    const snap = await repo.load()
    const account = snap.accounts[0]
    renderSettings(repo)
    const input = await screen.findByLabelText(`Saldo de abertura de ${account.name} (R$)`)
    await user.clear(input)
    await user.type(input, 'abc')
    await user.click(screen.getByRole('button', { name: `Salvar saldo de abertura de ${account.name}` }))
    expect(await screen.findByText('Valor inválido. Ex.: 1.250,50')).toBeTruthy()
  })

  it.each(['member', 'viewer'] as MemberRole[])('%s vê os dados apenas para leitura', async (role) => {
    renderSettings(new RoleRepository(role))
    expect(await screen.findByText('Somente proprietários e administradores podem alterar os dados da empresa.')).toBeTruthy()
    expect(screen.queryByLabelText('Nome da empresa')).toBeNull()
    expect(screen.queryByRole('button', { name: /Salvar saldo de abertura/ })).toBeNull()
  })

  it.each(['owner', 'admin'] as MemberRole[])('%s pode editar os dados da empresa', async (role) => {
    renderSettings(new RoleRepository(role))
    expect(await screen.findByLabelText('Nome da empresa')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Salvar saldo de abertura/ }).length).toBeGreaterThan(0)
  })
})
