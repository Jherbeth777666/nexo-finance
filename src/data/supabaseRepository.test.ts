import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_ALERT_CONFIG } from '@/domain/finance/alerts'
import { CONSERVATIVE_SCENARIO } from '@/domain/finance/projection'
import type { ValidTransaction } from '@/domain/transactions'
import type { CompanySnapshot } from './repository'
import { SupabaseRepository } from './supabaseRepository'

const snapshot = (over: Partial<CompanySnapshot> = {}): CompanySnapshot => ({
  company: { id: 'empresa-1', name: 'Empresa', timezone: 'America/Sao_Paulo', currency: 'BRL', isDemo: false, role: 'owner' },
  accounts: [
    { id: 'a1', name: 'Conta 1', openingBalance: 100_000, openingDate: '2026-01-01' },
    { id: 'a2', name: 'Conta 2', openingBalance: 0, openingDate: '2026-02-01' },
  ],
  categories: [],
  transactions: [],
  products: [],
  localEvents: [],
  alertStatus: {},
  audit: [],
  imports: [],
  scenarios: [],
  alertConfig: DEFAULT_ALERT_CONFIG,
  customScenario: { ...CONSERVATIVE_SCENARIO, id: 'custom' },
  anchor: '2026-03-15',
  ...over,
})

function fakeRepos(rowsByCall: unknown[], invokeResult: { data: unknown; error: unknown } = { data: null, error: null }) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = []
  const invokeCalls: { name: string; body: unknown }[] = []
  let call = 0
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      return Promise.resolve({ data: rowsByCall[call++], error: null })
    },
    functions: {
      invoke(name: string, opts: { body: unknown }) {
        invokeCalls.push({ name, body: opts.body })
        return Promise.resolve(invokeResult)
      },
    },
  } as unknown as SupabaseClient
  return { client, rpcCalls, invokeCalls }
}

function withSnapshot(repo: SupabaseRepository, snap: CompanySnapshot) {
  ;(repo as unknown as { fetchAll: () => Promise<CompanySnapshot> }).fetchAll = async () => snap
}

interface FakeBuilder {
  update(payload: Record<string, unknown>): FakeBuilder
  eq(column: string, value: unknown): FakeBuilder
  select(columns: string): Promise<{ data: unknown[]; error: null }>
}

function fakeClient() {
  const calls: { table: string; payload: Record<string, unknown> }[] = []
  let table = ''
  const builder: FakeBuilder = {
    update(payload) {
      calls.push({ table, payload })
      return builder
    },
    eq() {
      return builder
    },
    select() {
      // PostgREST devolve 0 linhas (sem erro) quando o RLS bloqueia o UPDATE.
      return Promise.resolve({ data: [], error: null })
    },
  }
  return {
    client: {
      from(name: string) {
        table = name
        return builder
      },
    } as unknown as SupabaseClient,
    calls,
  }
}

interface MutationCall {
  table: string
  op: 'update' | 'delete'
  payload?: Record<string, unknown>
  filters: { column: string; value: unknown }[]
}

function mutationClient(rows: unknown[]) {
  const calls: MutationCall[] = []
  let table = ''
  let current: MutationCall | null = null
  const builder: Record<string, unknown> = {}
  builder.update = (payload: Record<string, unknown>) => {
    current = { table, op: 'update', payload, filters: [] }
    calls.push(current)
    return builder
  }
  builder.delete = () => {
    current = { table, op: 'delete', filters: [] }
    calls.push(current)
    return builder
  }
  builder.eq = (column: string, value: unknown) => {
    current?.filters.push({ column, value })
    return builder
  }
  builder.neq = (column: string, value: unknown) => {
    current?.filters.push({ column, value })
    return builder
  }
  builder.select = () => Promise.resolve({ data: rows, error: null })
  return {
    client: {
      from(name: string) {
        table = name
        return builder
      },
    } as unknown as SupabaseClient,
    calls,
  }
}

describe('repositório Supabase e edição de configurações', () => {
  it('detecta update bloqueado pelo RLS e nunca envia company_id no payload', async () => {
    const { client, calls } = fakeClient()
    const repo = new SupabaseRepository(client, 'empresa-1', 'member')

    await expect(repo.updateCompanyName('Empresa Nova')).rejects.toThrow(/sem permissão/)
    expect(calls[0]).toEqual({ table: 'companies', payload: { name: 'Empresa Nova' } })
    expect(calls[0].payload).not.toHaveProperty('company_id')

    await expect(repo.updateAccountOpeningBalance('conta-1', -12345)).rejects.toThrow(/sem permissão/)
    expect(calls[1]).toEqual({ table: 'accounts', payload: { opening_balance: '-123.45' } })
    expect(calls[1].payload).not.toHaveProperty('company_id')
  })

  it('valida entrada antes de chamar o banco', async () => {
    const { client, calls } = fakeClient()
    const repo = new SupabaseRepository(client, 'empresa-1', 'viewer')
    await expect(repo.updateCompanyName(' a ')).rejects.toThrow(/2 a 120/)
    await expect(repo.updateAccountOpeningBalance('conta-1', 1.5)).rejects.toThrow(/inválido/)
    expect(calls).toHaveLength(0)
  })
})

describe('equipe no repositório Supabase', () => {
  it('cria convite pela RPC, normaliza o e-mail e nunca envia company_id no payload', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> }[] = []
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args })
        return Promise.resolve({ data: { id: 'convite-1', token: 'token-secreto' }, error: null })
      },
    } as unknown as SupabaseClient
    const repo = new SupabaseRepository(client, 'empresa-1', 'owner')

    const invite = await repo.createInvite({ email: '  Ana@Exemplo.com ', role: 'admin' })
    expect(invite).toMatchObject({ id: 'convite-1', email: 'ana@exemplo.com', role: 'admin', token: 'token-secreto' })
    expect(rpcCalls[0]).toEqual({
      name: 'create_invite',
      args: { p_company: 'empresa-1', p_email: 'ana@exemplo.com', p_role: 'admin' },
    })
    expect(rpcCalls[0].args).not.toHaveProperty('company_id')
  })

  it('valida e-mail, papel e revogação sem chamar o banco quando inválidos', async () => {
    const rpcCalls: string[] = []
    const client = {
      rpc(name: string) {
        rpcCalls.push(name)
        return Promise.resolve({ data: null, error: null })
      },
    } as unknown as SupabaseClient
    const repo = new SupabaseRepository(client, 'empresa-1', 'owner')
    await expect(repo.createInvite({ email: 'invalido', role: 'member' })).rejects.toThrow(/válido/)
    await expect(repo.createInvite({ email: 'a@b.co', role: 'owner' as never })).rejects.toThrow(/Papel inválido/)
    await expect(repo.updateMemberRole('u1', 'owner' as never)).rejects.toThrow(/Papel inválido/)
    expect(rpcCalls).toHaveLength(0)

    await repo.revokeInvite('convite-1')
    expect(rpcCalls).toEqual(['revoke_invite'])
  })

  it('detecta update/delete bloqueados pelo RLS e filtra o owner', async () => {
    const { client, calls } = mutationClient([])
    const repo = new SupabaseRepository(client, 'empresa-1', 'admin')

    await expect(repo.updateMemberRole('membro-1', 'viewer')).rejects.toThrow(/proprietário|permissão/)
    expect(calls[0]).toMatchObject({
      table: 'company_members',
      op: 'update',
      payload: { role: 'viewer' },
      filters: [
        { column: 'company_id', value: 'empresa-1' },
        { column: 'user_id', value: 'membro-1' },
        { column: 'role', value: 'owner' },
      ],
    })
    expect(calls[0].payload).not.toHaveProperty('company_id')

    await expect(repo.removeMember('membro-1')).rejects.toThrow(/proprietário|permissão/)
    expect(calls[1]).toMatchObject({
      table: 'company_members',
      op: 'delete',
      filters: [
        { column: 'company_id', value: 'empresa-1' },
        { column: 'user_id', value: 'membro-1' },
        { column: 'role', value: 'owner' },
      ],
    })
  })
})

describe('agregados e importação no repositório Supabase', () => {
  it('lê saldos por conta convertendo NUMERIC em centavos', async () => {
    const { client, rpcCalls } = fakeRepos([
      [
        { account_id: 'a2', balance: '0.00', settled_count: 0 },
        { account_id: 'a1', balance: '1234.56', settled_count: 3 },
      ],
    ])
    const repo = new SupabaseRepository(client, 'empresa-1', 'owner')
    withSnapshot(repo, snapshot())

    const balances = await repo.getAccountBalances('2026-03-15')
    expect(rpcCalls[0]).toEqual({ name: 'company_balances', args: { p_company: 'empresa-1', p_as_of: '2026-03-15' } })
    expect(balances.map((b) => [b.account.id, b.balance, b.settledCount])).toEqual([
      ['a1', 123_456, 3],
      ['a2', 0, 0],
    ])
  })

  it('mapeia a evolução mensal e a projeção-base', async () => {
    const evolution = [{ month: '2026-03', cash_in: '100.00', cash_out: '40.50', net: '59.50', end_balance: '-10.00' }]
    const projection = [
      {
        day: '2026-03-15',
        inflow: '0.00',
        outflow: '200.00',
        balance: '-100.00',
        pressure_rank: 1,
        start_balance: '100.00',
        end_balance: '-50.00',
        total_in: '150.00',
        total_out: '200.00',
        min_balance: '-100.00',
        min_date: '2026-03-15',
        first_negative_date: '2026-03-15',
        negative_days: 2,
        last_inflow_date: '2026-03-16',
        overdue_receivables_amount: '70.00',
        overdue_receivables_count: 1,
        beyond_horizon_amount: '25.00',
        beyond_horizon_count: 1,
      },
      {
        day: '2026-03-16',
        inflow: '150.00',
        outflow: '0.00',
        balance: '50.00',
        pressure_rank: null,
        start_balance: '100.00',
        end_balance: '-50.00',
        total_in: '150.00',
        total_out: '200.00',
        min_balance: '-100.00',
        min_date: '2026-03-15',
        first_negative_date: '2026-03-15',
        negative_days: 2,
        last_inflow_date: '2026-03-16',
        overdue_receivables_amount: '70.00',
        overdue_receivables_count: 1,
        beyond_horizon_amount: '25.00',
        beyond_horizon_count: 1,
      },
    ]
    const { client, rpcCalls } = fakeRepos([evolution, projection])
    const repo = new SupabaseRepository(client, 'empresa-1', 'owner')
    withSnapshot(repo, snapshot())

    expect(await repo.getMonthlyEvolution('2026-03-15', 3)).toEqual([{ month: '2026-03', cashIn: 10_000, cashOut: 4_050, net: 5_950, endBalance: -1_000 }])
    expect(rpcCalls[0]).toEqual({ name: 'monthly_evolution', args: { p_company: 'empresa-1', p_as_of: '2026-03-15', p_months: 3 } })

    const p = await repo.getBaseProjection('2026-03-15', 2)
    expect(rpcCalls[1]).toEqual({ name: 'base_projection', args: { p_company: 'empresa-1', p_as_of: '2026-03-15', p_days: 2 } })
    expect(p).toMatchObject({
      asOf: '2026-03-15',
      endDate: '2026-03-16',
      horizonDays: 2,
      startBalance: 10_000,
      endBalance: -5_000,
      totalIn: 15_000,
      totalOut: 20_000,
      minBalance: -10_000,
      minDate: '2026-03-15',
      firstNegativeDate: '2026-03-15',
      negativeDays: 2,
      lastInflowDate: '2026-03-16',
      excluded: {
        overdueReceivables: { amount: 7_000, count: 1 },
        beyondHorizon: { amount: 2_500, count: 1 },
      },
    })
    expect(p.days.map((d) => d.date)).toEqual(['2026-03-15', '2026-03-16'])
    expect(p.pressureDays.map((d) => d.date)).toEqual(['2026-03-15'])
  })

  it('importa com functions.invoke e nunca chama a RPC diretamente', async () => {
    const rec = {
      id: 'imp-1',
      fileName: 'a.csv',
      fileHash: 'a'.repeat(64),
      at: 't',
      actor: 'Você',
      totalRows: 2,
      imported: 1,
      skipped: 1,
      errors: 0,
      warnings: 0,
    }
    const { client, rpcCalls, invokeCalls } = fakeRepos([], { data: { importId: 'imp-1' }, error: null })
    const repo = new SupabaseRepository(client, 'empresa-1', 'member')
    withSnapshot(repo, snapshot({ imports: [rec] }))

    const rows: ValidTransaction[] = [
      {
        kind: 'income',
        status: 'settled',
        description: 'Venda',
        categoryId: null,
        accountId: 'a1',
        amount: 123_456,
        competenceDate: '2026-03-01',
        dueDate: '2026-03-01',
        settledDate: '2026-03-01',
      },
    ]
    const result = await repo.importTransactions(rows, {
      fileName: 'a.csv',
      fileHash: 'a'.repeat(64),
      totalRows: 2,
      imported: 1,
      skipped: 1,
      errors: 0,
      warnings: 0,
    })

    expect(result).toEqual(rec)
    expect(rpcCalls).toHaveLength(0)
    expect(invokeCalls[0]).toEqual({
      name: 'import-transactions',
      body: {
        companyId: 'empresa-1',
        fileName: 'a.csv',
        fileHash: 'a'.repeat(64),
        stats: { totalRows: 2, skipped: 1, errors: 0, warnings: 0 },
        rows,
      },
    })
  })

  it('solicita análise por agente à Edge Function e normaliza a resposta', async () => {
    const data = {
      analysis: {
        agent: 'cash',
        generatedBy: 'ai',
        summary: 'Resumo.',
        period: { start: '2026-03-15', end: '2026-04-13' },
        evidence: [{ claim: 'Saldo: R$ 10,00', factKey: 'start' }],
        assumptions: ['Premissa.'],
        limitations: ['Limitação.'],
        suggestedActions: [],
      },
      facts: { start: { label: 'Saldo', value: 1_000 } },
      review: { valid: true, issues: [] },
      cached: true,
      provider: 'fake',
      model: 'fake',
    }
    const { client, rpcCalls, invokeCalls } = fakeRepos([], { data, error: null })
    const repo = new SupabaseRepository(client, 'empresa-1', 'member')

    const result = await repo.requestAnalysis('cash')
    expect(rpcCalls).toHaveLength(0)
    expect(invokeCalls[0]).toEqual({ name: 'ai-analysis', body: { companyId: 'empresa-1', agent: 'cash' } })
    expect(result).toMatchObject({ status: 'ok', cached: true, provider: 'fake', model: 'fake' })
  })

  it('preserva a mensagem de IA desligada e recusa resposta sem análise', async () => {
    const error = {
      message: 'Edge Function returned a non-2xx status code',
      context: new Response(JSON.stringify({ error: 'IA não configurada neste ambiente.' }), { status: 503 }),
    }
    const first = fakeRepos([], { data: null, error })
    await expect(new SupabaseRepository(first.client, 'empresa-1', 'member').requestAnalysis('cash')).rejects.toThrow('IA não configurada neste ambiente.')

    const second = fakeRepos([], { data: { status: 'ok' }, error: null })
    await expect(new SupabaseRepository(second.client, 'empresa-1', 'member').requestAnalysis('cash')).rejects.toThrow(
      'Resposta inválida do servidor de análises.',
    )
  })

  it('propaga os erros por linha da Edge Function sem expor o JWT', async () => {
    const error = {
      message: 'Edge Function returned a non-2xx status code',
      context: new Response(JSON.stringify({ error: 'Importação recusada.', errors: [{ line: 3, message: 'Conta inválida.' }] }), { status: 400 }),
    }
    const { client } = fakeRepos([], { data: null, error })
    const repo = new SupabaseRepository(client, 'empresa-1', 'member')

    await expect(repo.importTransactions([], {} as never)).rejects.toThrow('Linha 3: Conta inválida.')
  })

  it('usa mensagem genérica quando a Edge Function não devolve corpo útil', async () => {
    const { client } = fakeRepos([], { data: null, error: { message: 'falha interna com detalhes' } })
    const repo = new SupabaseRepository(client, 'empresa-1', 'member')

    await expect(repo.importTransactions([], {} as never)).rejects.toThrow('Não foi possível concluir a importação. Tente novamente.')
  })
})
