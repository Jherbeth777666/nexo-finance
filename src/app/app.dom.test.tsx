// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { App } from '@/App'
import { DemoRepository } from '@/data/demoRepository'
import { DataProvider, useStore } from '@/data/store'
import type { FinanceRepository } from '@/data/repository'
import { ToastProvider } from '@/components/overlay'
import { Segmented } from '@/components/ui'
import { AuthProvider } from '@/features/auth/session'
import SettingsPage from '@/features/settings/SettingsPage'
import IntelligencePage from '@/features/intelligence/IntelligencePage'
import type { AiAnalysisResponse } from '@/data/repository'
import { accountBalances } from '@/domain/finance/metrics'
import type { MemberRole } from '@/domain/types'
import { formatBRL } from '@/lib/money'
import { addDays, todayIn } from '@/lib/dates'
import { validateLogin, validateSignup } from '@/features/auth/validation'
import { PENDING_INVITE_KEY, readPendingInvite, savePendingInvite } from '@/features/invites/pendingInvite'

beforeAll(async () => {
  if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import('node:crypto')
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
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

function ReadyIntelligence() {
  const { status } = useStore()
  return status.kind === 'ready' ? <IntelligencePage /> : null
}

const renderIntelligence = (repository: FinanceRepository) =>
  render(
    <ToastProvider>
      <DataProvider repository={repository}>
        <MemoryRouter>
          <ReadyIntelligence />
        </MemoryRouter>
      </DataProvider>
    </ToastProvider>,
  )

const aiResponse = (over: Partial<AiAnalysisResponse> = {}): AiAnalysisResponse => ({
  analysis: {
    agent: 'cash',
    generatedBy: 'ai',
    summary: 'Resumo gerado pelo servidor.',
    period: { start: '2026-03-15', end: '2026-04-13' },
    evidence: [{ claim: 'Saldo registrado consultado.', factKey: 'start' }],
    assumptions: ['Cenário-base.'],
    limitations: ['Estimativa baseada nos lançamentos registrados.'],
    suggestedActions: ['Acompanhar o caixa.'],
  },
  facts: { start: { label: 'Saldo registrado', value: 100_000 } },
  review: { valid: true, issues: [] },
  status: 'ok',
  cached: true,
  provider: 'fake',
  ...over,
})

function serverRepository(request: FinanceRepository['requestAnalysis']): FinanceRepository {
  const repo = new DemoRepository(null)
  Object.defineProperty(repo, 'mode', { value: 'supabase' })
  Object.defineProperty(repo, 'requestAnalysis', { value: request })
  return repo
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

  it('produtos: mostra ranking, catálogo e permite editar um produto', async () => {
    const user = userEvent.setup()
    renderAt('/app/produtos')
    expect(await screen.findByRole('heading', { name: 'O que vende, o que parou e o que repor' }, { timeout: 5000 })).toBeTruthy()
    expect(await screen.findByText('Ranking por faturamento (30 dias)')).toBeTruthy()
    expect((await screen.findAllByText('Arroz branco 5 kg')).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('radio', { name: 'Catálogo' }))
    const catalog = await screen.findByRole('table', { name: 'Catálogo de produtos' })
    const row = within(catalog).getByText('Arroz branco 5 kg').closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Editar' }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText('Nome')
    await user.clear(name)
    await user.type(name, 'Arroz premium 5 kg')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText('Produto atualizado')).toBeTruthy()
    expect((await screen.findAllByText('Arroz premium 5 kg')).length).toBeGreaterThan(0)
  })

  it('produtos: mostra os menos vendidos e alterna o ranking por faturamento e quantidade', async () => {
    const user = userEvent.setup()
    renderAt('/app/produtos')
    expect(await screen.findByRole('heading', { name: 'O que vende, o que parou e o que repor' }, { timeout: 5000 })).toBeTruthy()

    expect(await screen.findByText('Ranking por faturamento (30 dias)')).toBeTruthy()
    const byRevenue = screen.getByRole('radio', { name: 'Por faturamento' })
    const byQuantity = screen.getByRole('radio', { name: 'Por quantidade' })
    expect(byRevenue.getAttribute('aria-checked')).toBe('true')
    expect(byQuantity.getAttribute('aria-checked')).toBe('false')

    const leastHeading = await screen.findByText('Menos vendidos (90 dias)')
    const leastPanel = leastHeading.closest('section')!
    expect(within(leastPanel).getByText(/Carvão 3 kg/)).toBeTruthy()

    await user.click(byQuantity)
    expect(await screen.findByText('Ranking por quantidade (30 dias)')).toBeTruthy()
    expect(byQuantity.getAttribute('aria-checked')).toBe('true')
    expect(byRevenue.getAttribute('aria-checked')).toBe('false')
  })

  it('produtos: importa vendas por item de um CSV', async () => {
    const user = userEvent.setup()
    const today = todayIn()
    const [year, month, day] = today.split('-')
    const csv = `Data,Produto,Código,Quantidade,Valor total
${day}/${month}/${year},Café Teste,CAFT,2,"99999,00"
`
    renderAt('/app/produtos')
    await screen.findByRole('heading', { name: 'O que vende, o que parou e o que repor' }, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Importar vendas por item' }))
    const dialog = await screen.findByRole('dialog')
    const file = new File([csv], 'vendas.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(csv).buffer })
    await user.upload(within(dialog).getByLabelText('Arquivo de vendas por item'), file)
    expect(await within(dialog).findByText(/1 linha\(s\)/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Validar planilha' }))
    expect(await within(dialog).findByText('1 a importar')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Importar 1 venda(s)' }))
    expect(await screen.findByText('Vendas por item importadas')).toBeTruthy()
    // As vendas são recarregadas quando data.imports muda; sem isso o ranking ficaria vazio.
    const ranking = (await screen.findByText('Ranking por faturamento (30 dias)')).closest('section')!
    expect(await within(ranking).findByText('Café Teste')).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: 'Catálogo' }))
    const catalog = await screen.findByRole('table', { name: 'Catálogo de produtos' })
    expect(await within(catalog).findByText('Café Teste')).toBeTruthy()
  })

  it('produtos: ao mudar o estoque, data da contagem vira hoje e data futura é barrada', async () => {
    const user = userEvent.setup()
    const today = todayIn()
    renderAt('/app/produtos')
    await screen.findByRole('heading', { name: 'O que vende, o que parou e o que repor' }, { timeout: 5000 })
    await user.click(screen.getByRole('radio', { name: 'Catálogo' }))
    const catalog = await screen.findByRole('table', { name: 'Catálogo de produtos' })
    const row = within(catalog).getByText('Arroz branco 5 kg').closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Editar' }))
    const dialog = await screen.findByRole('dialog')
    const stock = within(dialog).getByLabelText('Estoque atual')
    await user.clear(stock)
    await user.type(stock, '12')
    const stockDate = within(dialog).getByLabelText('Data da contagem') as HTMLInputElement
    expect(stockDate.value).toBe(today)
    fireEvent.change(stockDate, { target: { value: addDays(today, 1) } })
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    expect(await within(dialog).findByText(/não pode estar no futuro/)).toBeTruthy()
  })

  it('produtos: reconhece venda já importada mesmo fora da janela carregada', async () => {
    const user = userEvent.setup()
    const today = todayIn()
    const [year, month, day] = addDays(today, -400).split('-')
    const csv = `Data,Produto,Código,Quantidade,Valor total
${day}/${month}/${year},Café antigo,CAFA,1,"10,00"
`
    renderAt('/app/produtos')
    await screen.findByRole('heading', { name: 'O que vende, o que parou e o que repor' }, { timeout: 5000 })

    const upload = async () => {
      await user.click(screen.getByRole('button', { name: 'Importar vendas por item' }))
      const dialog = await screen.findByRole('dialog')
      const file = new File([csv], 'vendas-antigas.csv', { type: 'text/csv' })
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(csv).buffer })
      await user.upload(within(dialog).getByLabelText('Arquivo de vendas por item'), file)
      expect(await within(dialog).findByText(/1 linha\(s\)/)).toBeTruthy()
      await user.click(within(dialog).getByRole('button', { name: 'Validar planilha' }))
      return dialog
    }

    const first = await upload()
    expect(await within(first).findByText('1 a importar')).toBeTruthy()
    await user.click(within(first).getByRole('button', { name: 'Importar 1 venda(s)' }))
    expect(await screen.findByText('Vendas por item importadas')).toBeTruthy()

    const second = await upload()
    expect(await within(second).findByText('1 já importada(s)')).toBeTruthy()
    expect(within(second).getByText('0 a importar')).toBeTruthy()
  })

  it('produtos: sazonalidade usa o histórico maior que 90 dias', async () => {
    const user = userEvent.setup()
    renderAt('/app/produtos')
    await screen.findByRole('heading', { name: 'O que vende, o que parou e o que repor' }, { timeout: 5000 })
    await user.click(screen.getByRole('radio', { name: 'Sazonalidade' }))
    expect(await screen.findByText(/Com 180 dias de histórico/)).toBeTruthy()
  })

  it('produtos: cadastra evento local na sazonalidade', async () => {
    const user = userEvent.setup()
    renderAt('/app/produtos')
    await screen.findByRole('heading', { name: 'O que vende, o que parou e o que repor' }, { timeout: 5000 })
    await user.click(screen.getByRole('radio', { name: 'Sazonalidade' }))
    expect(await screen.findByText('Sazonalidade observada no seu histórico')).toBeTruthy()
    await user.type(screen.getByLabelText('Nome do evento'), 'Festejo do padroeiro')
    await user.click(screen.getByRole('button', { name: 'Adicionar evento' }))
    expect(await screen.findByText('Evento local cadastrado')).toBeTruthy()
    expect(await screen.findByText(/Festejo do padroeiro ·/)).toBeTruthy()
  })

  it('produtos: repõe com rótulos acessíveis nos cartões e na tabela', async () => {
    const user = userEvent.setup()
    renderAt('/app/produtos')
    await screen.findByRole('heading', { name: 'O que vende, o que parou e o que repor' }, { timeout: 5000 })
    const tab = await screen.findByRole('radio', { name: /^Reposição/ })
    await user.click(tab)
    const heading = await screen.findByRole('heading', { name: /(Cobertura de estoque|pedem atenção)/ })
    const panel = heading.closest('section')!
    expect(within(panel).getByRole('table', { name: 'Sugestões de reposição' })).toBeTruthy()
    expect(within(panel).getAllByText('Estoque estimado').length).toBeGreaterThan(0)
    expect(within(panel).getAllByText('Cobertura').length).toBeGreaterThan(0)
  })

  it('controle segmentado anuncia o contador no nome acessível', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        label="Seções"
        value="visao"
        onChange={onChange}
        options={[
          { value: 'visao', label: 'Visão' },
          { value: 'reposicao', label: 'Reposição', count: 3 },
        ]}
      />,
    )
    const group = screen.getByRole('radiogroup', { name: 'Seções' })
    expect(group.className).toContain('overflow-x-auto')
    // O contador faz parte do nome acessível: leitor de tela ouve "Reposição (3)".
    const reposicao = screen.getByRole('radio', { name: 'Reposição (3)' })
    expect(reposicao.textContent).toContain('3')
    fireEvent.click(reposicao)
    expect(onChange).toHaveBeenCalledWith('reposicao')
  })

  it('inteligência em demonstração mostra exemplo local sem chamar IA', async () => {
    const user = userEvent.setup()
    renderAt('/app/inteligencia')
    expect(await screen.findByRole('heading', { name: 'Agente de caixa' }, { timeout: 5000 })).toBeTruthy()
    expect(screen.getByText('Análises por IA indisponíveis')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Ver exemplo demonstrativo/ }))
    expect(await screen.findByText('Exemplo demonstrativo')).toBeTruthy()
    expect(screen.getByText(/Nenhuma IA foi chamada/)).toBeTruthy()
    expect(screen.getByText(/Revisor de análises/)).toBeTruthy()
  })

  it('inteligência no servidor gera por agente e mostra o selo do revisor', async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    const repo = serverRepository(async (agent) => {
      calls.push(agent)
      return aiResponse()
    })
    renderIntelligence(repo)

    expect(await screen.findByRole('heading', { name: 'Agente de análise' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Gerar análise' }))
    expect(await screen.findByText('Resumo gerado pelo servidor.')).toBeTruthy()
    expect(screen.getByText('Gerado por IA, revisado automaticamente')).toBeTruthy()
    expect(screen.getByText('Do cache')).toBeTruthy()

    await user.click(screen.getByRole('radio', { name: 'Despesas' }))
    await user.click(screen.getByRole('button', { name: 'Gerar análise' }))
    await waitFor(() => expect(calls).toEqual(['cash', 'expenses']))
  })

  it('inteligência no servidor mostra erro e análise reprovada sem confundir com confiável', async () => {
    const user = userEvent.setup()
    const failing = serverRepository(async () => {
      throw new Error('Cota mensal de análises de IA esgotada.')
    })
    renderIntelligence(failing)
    await user.click(await screen.findByRole('button', { name: 'Gerar análise' }))
    expect(await screen.findByText('Cota mensal de análises de IA esgotada.')).toBeTruthy()
    cleanup()

    const rejected = serverRepository(async () =>
      aiResponse({ status: 'rejected', review: { valid: false, issues: ['Valor citado não corresponde a nenhum cálculo: R$ 9,99'] } }),
    )
    renderIntelligence(rejected)
    await user.click(await screen.findByRole('button', { name: 'Gerar análise' }))
    expect(await screen.findByText('Gerada por IA — reprovada pelo revisor')).toBeTruthy()
    expect(screen.getByText(/Não use como referência/)).toBeTruthy()
    expect(screen.queryByText('Gerado por IA, revisado automaticamente')).toBeNull()
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

describe('segundo passe visual', () => {
  it('landing: prévia empilha os KPIs no celular e mantém a faixa de confiança', async () => {
    renderAt('/')
    expect(await screen.findByRole('heading', { name: /Veja o que vem antes do problema/ }, { timeout: 5000 })).toBeTruthy()

    const saldoCell = screen.getByText('Saldo hoje').closest('div')!
    const previewGrid = saldoCell.parentElement!
    expect(previewGrid.className).toContain('grid-cols-1')
    expect(previewGrid.className).toContain('sm:grid-cols-3')
    expect(saldoCell.querySelector('.num')!.className).toContain('text-lg')

    for (const label of ['Cálculos auditáveis', 'Isolamento entre empresas', 'IA opcional e revisada', 'Só dados agregados vão à IA']) {
      expect(screen.getByText(label)).toBeTruthy()
    }

    const cta = screen.getByRole('link', { name: 'Comece pela demonstração' })
    expect(cta.getAttribute('href')).toBe('/app/overview?modo=demo')
    expect(screen.getAllByRole('link', { name: 'Criar conta' }).some((link) => link.getAttribute('href') === '/cadastro')).toBe(true)
  })

  it('visão geral: destaca o saldo e usa cor com significado nos KPIs', async () => {
    renderAt('/app/overview')
    await screen.findByRole('heading', { name: 'Situação financeira' }, { timeout: 5000 })

    const cellFor = (label: string) => screen.getByText(label, { selector: '.eyebrow' }).closest('div')!.parentElement!
    const valueClassFor = (label: string) => cellFor(label).querySelector('.min-h-8')!.firstElementChild?.className ?? ''

    const saldoCell = cellFor('Saldo registrado')
    expect(saldoCell.className).toContain('sm:col-span-2')
    expect(saldoCell.className).toContain('ring-accent')
    expect(saldoCell.parentElement!.className).toContain('grid-cols-1')
    expect(saldoCell.parentElement!.className).toContain('lg:grid-cols-6')

    expect(valueClassFor('A receber')).toContain('text-pos')
    expect(valueClassFor('A pagar')).toContain('text-risk')
  })

  it('visão geral: estrutura a evolução em uma lista descritiva válida', async () => {
    renderAt('/app/overview')
    await screen.findByRole('heading', { name: 'Situação financeira' }, { timeout: 5000 })

    const panel = screen.getByText('Evolução').closest('section')!
    const dl = panel.querySelector('dl')!
    expect(dl).toBeTruthy()

    const rows = Array.from(dl.children)
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.tagName).toBe('DIV')
      expect(Array.from(row.children).map((child) => child.tagName)).toEqual(['DT', 'DD'])
    }

    const currentMonth = screen.getByText(/^Mês atual · /)
    const competence = screen.getByText(/^Competência, simplificado/)
    expect(dl.contains(currentMonth)).toBe(false)
    expect(dl.contains(competence)).toBe(false)
    expect(rows[2].className).toContain('border-t')
    expect(rows[2].className).toContain('pt-3')
  })

  it('visão geral: botões de definição têm 24x24px e abrem/fecham a nota sem navegar', async () => {
    const user = userEvent.setup()
    renderAt('/app/overview')
    await screen.findByRole('heading', { name: 'Situação financeira' }, { timeout: 5000 })

    const buttons = screen.getAllByRole('button', { name: /^Definição:/ })
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button.className).toContain('h-6')
      expect(button.className).toContain('w-6')
      expect(button.className).toContain('-m-1')
    }

    const button = screen.getByRole('button', { name: 'Definição: Saldo registrado' })
    await user.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const note = screen.getByRole('note')
    expect(button.getAttribute('aria-controls')).toBe(note.id)
    expect(screen.getByRole('heading', { name: 'Situação financeira' })).toBeTruthy()

    await user.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('note')).toBeNull()

    await user.click(button)
    expect(screen.getByRole('note')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Situação financeira' })).toBeTruthy()
  })

  it('visão geral: mostra 3 alertas e expande a lista na própria página', async () => {
    const user = userEvent.setup()
    renderAt('/app/overview')
    await screen.findByRole('heading', { name: 'Situação financeira' }, { timeout: 5000 })

    const panel = screen.getByText('O que merece atenção').closest('section')!
    const alertLinks = () =>
      within(panel)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('href')?.startsWith('/app/inteligencia?alerta='))
    expect(alertLinks()).toHaveLength(3)

    const button = within(panel).getByRole('button', { name: /^Ver todos \(\d+\)$/ })
    const total = Number(button.textContent!.match(/\d+/)![0])
    expect(total).toBeGreaterThan(3)

    await user.click(button)
    expect(alertLinks()).toHaveLength(total)
    expect(within(panel).getByRole('button', { name: 'Mostrar menos' })).toBeTruthy()
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
  it('explica que a IA está desligada por padrão no plano trial', async () => {
    renderSettings(new RoleRepository('owner'))
    expect(await screen.findByText('Desligada por padrão')).toBeTruthy()
    expect(screen.getByText(/plano trial permite 0 análises por mês/)).toBeTruthy()
  })

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

describe('equipe', () => {
  it.each(['member', 'viewer'] as MemberRole[])('%s vê a lista, mas não gerencia a equipe', async (role) => {
    renderSettings(new RoleRepository(role))
    expect(await screen.findByText('Marina Costa (fictícia)')).toBeTruthy()
    expect(screen.getByText('Proprietário')).toBeTruthy()
    expect(screen.queryByLabelText('Convidar por e-mail')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Convidar' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Remover/ })).toBeNull()
    expect(screen.queryByLabelText(/Papel de /)).toBeNull()
  })

  it.each(['owner', 'admin'] as MemberRole[])('%s convida e recebe o link gerado', async (role) => {
    const user = userEvent.setup()
    renderSettings(new RoleRepository(role))
    await screen.findByText('Marina Costa (fictícia)')

    await user.type(screen.getByLabelText('Convidar por e-mail'), 'novo@exemplo.com')
    await user.click(screen.getByRole('button', { name: 'Convidar' }))

    const link = (await screen.findByLabelText('Link do convite')) as HTMLInputElement
    expect(link.value).toMatch(/\/convite\/demo-/)
    expect(screen.getByText('novo@exemplo.com')).toBeTruthy()
    expect(screen.getByText(/Link de demonstração/)).toBeTruthy()
  })

  it('copia o link do convite', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderSettings(new RoleRepository('owner'))
    await screen.findByText('Marina Costa (fictícia)')
    await user.type(screen.getByLabelText('Convidar por e-mail'), 'copiar@exemplo.com')
    await user.click(screen.getByRole('button', { name: 'Convidar' }))
    const link = (await screen.findByLabelText('Link do convite')) as HTMLInputElement
    await user.click(screen.getByRole('button', { name: 'Copiar link' }))
    expect(writeText).toHaveBeenCalledWith(link.value)
    expect(await screen.findByText('Link do convite copiado')).toBeTruthy()
  })
})

describe('convite de membros', () => {
  it('cadastro de convidado não pede o nome da empresa', async () => {
    const user = userEvent.setup()
    savePendingInvite('token-de-convite')
    renderAt('/cadastro')
    expect(await screen.findByRole('heading', { name: 'Criar conta' }, { timeout: 5000 })).toBeTruthy()
    const name = screen.getByLabelText('Seu nome')
    const email = screen.getByLabelText('E-mail')
    const password = screen.getByLabelText('Senha')
    expect(screen.queryByLabelText('Nome da empresa')).toBeNull()
    await user.type(name, 'Pessoa Convidada')
    await user.type(email, 'convidada@exemplo.com')
    await user.type(password, 'senhaforte123') // gitleaks:allow (senha fictícia de teste)
    await user.type(screen.getByLabelText('Confirmar senha'), 'senhaforte123')
    await user.click(screen.getByRole('button', { name: 'Criar conta' }))
    expect(screen.queryByText('Informe o nome da empresa')).toBeNull()
  })

  it('cadastro comum continua exigindo o nome da empresa', async () => {
    renderAt('/cadastro')
    expect(await screen.findByLabelText('Nome da empresa', {}, { timeout: 5000 })).toBeTruthy()
  })

  it('/convite/:token guarda o token e explica o modo de demonstração', async () => {
    renderAt('/convite/token-abc-123')
    expect(await screen.findByText('Convite de demonstração', {}, { timeout: 5000 })).toBeTruthy()
    expect(readPendingInvite()).toBe('token-abc-123')
    expect(screen.getByText(/Convites de equipe funcionam somente com o Supabase/)).toBeTruthy()
  })

  it('descarta convite pendente com mais de 7 dias', () => {
    localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ token: 'antigo', savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }))
    expect(readPendingInvite()).toBeNull()
    expect(localStorage.getItem(PENDING_INVITE_KEY)).toBeNull()
  })
})
