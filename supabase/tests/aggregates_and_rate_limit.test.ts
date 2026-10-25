import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Account } from '@/domain/types'
import { accountBalances, monthlyEvolution } from '@/domain/finance/metrics'
import { BASE_SCENARIO, projectCashflow } from '@/domain/finance/projection'
import { addDays, todayIn } from '@/lib/dates'
import { numericToCents, rowToTransaction, type TxRow } from '@/data/supabaseMapping'

/**
 * Paridade centavo a centavo entre as funções SQL de agregados e o domínio TypeScript, além do
 * rate limit da importação. Roda apenas com as três variáveis de .env.test.local (projeto de
 * TESTE); sem elas a suíte é pulada, como isolation.test.ts.
 */
const URL = process.env.SUPABASE_TEST_URL
const ANON = process.env.SUPABASE_TEST_ANON_KEY
const SERVICE = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
const configured = !!(URL && ANON && SERVICE)

const run = Math.random().toString(36).slice(2, 8)
const password = `Teste-${run}-senha-123`
const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const today = todayIn('America/Sao_Paulo')
const day = (offset: number) => addDays(today, offset)

let admin: SupabaseClient
let owner: SupabaseClient
let userId = ''
let company = ''
let account1 = ''
let account2 = ''

async function makeOwner() {
  const email = `nexo-agregados-${run}@example.com`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'Teste agregados' } })
  if (error) throw error
  userId = data.user.id
  const sb = createClient(URL!, ANON!, opts)
  const { error: signInError } = await sb.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
  return sb
}

const transaction = (over: Record<string, unknown>) => ({
  company_id: company,
  kind: 'expense',
  status: 'pending',
  description: 'Lançamento de teste',
  account_id: account1,
  amount: '10.00',
  competence_date: today,
  due_date: today,
  ...over,
})

describe.skipIf(!configured)('agregados SQL × domínio e rate limit da importação', () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, opts)
    owner = await makeOwner()

    const created = await owner.rpc('create_company', { p_name: `Agregados ${run}`, p_opening_balance: 100 })
    if (created.error) throw created.error
    company = created.data as string

    const first = await owner.from('accounts').select('id').eq('company_id', company).limit(1).single()
    if (first.error) throw first.error
    account1 = first.data.id as string

    const second = await owner
      .from('accounts')
      .insert({ company_id: company, name: 'Reserva', opening_balance: '0.00', opening_date: day(-90) })
      .select('id')
      .single()
    if (second.error) throw second.error
    account2 = second.data.id as string

    const rows = [
      {
        kind: 'income',
        status: 'settled',
        description: 'Receita antiga',
        account_id: account1,
        amount: '300.00',
        competence_date: day(-40),
        due_date: day(-40),
        settled_date: day(-40),
      },
      {
        kind: 'income',
        status: 'settled',
        description: 'Receita 3m',
        account_id: account1,
        amount: '150.00',
        competence_date: day(-75),
        due_date: day(-75),
        settled_date: day(-75),
      },
      {
        kind: 'expense',
        status: 'settled',
        description: 'Despesa 2m',
        account_id: account1,
        amount: '90.00',
        competence_date: day(-45),
        due_date: day(-45),
        settled_date: day(-45),
      },
      {
        kind: 'expense',
        status: 'settled',
        description: 'Despesa recente',
        account_id: account1,
        amount: '50.00',
        competence_date: today,
        due_date: today,
        settled_date: today,
      },
      {
        kind: 'transfer',
        status: 'settled',
        description: 'Aporte',
        account_id: account1,
        to_account_id: account2,
        amount: '30.00',
        competence_date: today,
        due_date: today,
        settled_date: today,
      },
      {
        kind: 'transfer',
        status: 'settled',
        description: 'Aporte antigo',
        account_id: account1,
        to_account_id: account2,
        amount: '40.00',
        competence_date: day(-30),
        due_date: day(-30),
        settled_date: day(-30),
      },
      {
        kind: 'expense',
        status: 'settled',
        description: 'Despesa reserva',
        account_id: account2,
        amount: '20.00',
        competence_date: day(-10),
        due_date: day(-10),
        settled_date: day(-10),
      },
      {
        kind: 'income',
        status: 'pending',
        description: 'Receber atrasado',
        account_id: account1,
        amount: '70.00',
        competence_date: day(-10),
        due_date: day(-5),
      },
      { kind: 'income', status: 'pending', description: 'Receber futuro', account_id: account1, amount: '80.00', competence_date: today, due_date: day(10) },
      { kind: 'income', status: 'pending', description: 'Receber curto', account_id: account1, amount: '120.00', competence_date: today, due_date: day(3) },
      {
        kind: 'expense',
        status: 'pending',
        description: 'Pagar atrasado',
        account_id: account1,
        amount: '200.00',
        competence_date: day(-10),
        due_date: day(-3),
      },
      { kind: 'expense', status: 'pending', description: 'Pagar futuro', account_id: account1, amount: '60.00', competence_date: today, due_date: day(15) },
      { kind: 'income', status: 'cancelled', description: 'Cancelado', account_id: account1, amount: '999.00', competence_date: today, due_date: day(5) },
      {
        kind: 'transfer',
        status: 'pending',
        description: 'Transferência prevista',
        account_id: account1,
        to_account_id: account2,
        amount: '999.00',
        competence_date: today,
        due_date: day(8),
      },
      { kind: 'income', status: 'pending', description: 'Receber longe', account_id: account1, amount: '50.00', competence_date: today, due_date: day(100) },
      { kind: 'expense', status: 'pending', description: 'Pagar longe', account_id: account1, amount: '25.00', competence_date: today, due_date: day(100) },
    ].map(transaction)
    const inserted = await owner.from('transactions').insert(rows)
    if (inserted.error) throw inserted.error
  })

  it('company_balances coincide com accountBalances, inclusive transferências e abertura', async () => {
    const [accountsResult, txsResult] = await Promise.all([
      owner.from('accounts').select('id,name,opening_balance,opening_date').eq('company_id', company).order('created_at'),
      owner.from('transactions').select('*').eq('company_id', company),
    ])
    if (accountsResult.error) throw accountsResult.error
    if (txsResult.error) throw txsResult.error

    const accounts: Account[] = (accountsResult.data as { id: string; name: string; opening_balance: string; opening_date: string }[]).map((a) => ({
      id: a.id,
      name: a.name,
      openingBalance: numericToCents(a.opening_balance),
      openingDate: a.opening_date,
    }))
    const txs = (txsResult.data as TxRow[]).map(rowToTransaction)

    const expected = new Map(accountBalances(accounts, txs, today).map((b) => [b.account.id, { balance: b.balance, settledCount: b.settledCount }]))
    const { data, error } = await owner.rpc('company_balances', { p_company: company, p_as_of: today })
    if (error) throw error

    expect((data as unknown[]).length).toBe(accounts.length)
    for (const row of data as { account_id: string; balance: string; settled_count: number }[]) {
      expect({ balance: numericToCents(row.balance), settledCount: row.settled_count }, row.account_id).toEqual(expected.get(row.account_id))
    }
  })

  it('monthly_evolution coincide com monthlyEvolution em todos os meses', async () => {
    const [accountsResult, txsResult] = await Promise.all([
      owner.from('accounts').select('id,name,opening_balance,opening_date').eq('company_id', company).order('created_at'),
      owner.from('transactions').select('*').eq('company_id', company),
    ])
    if (accountsResult.error) throw accountsResult.error
    if (txsResult.error) throw txsResult.error
    const accounts: Account[] = (accountsResult.data as { id: string; name: string; opening_balance: string; opening_date: string }[]).map((a) => ({
      id: a.id,
      name: a.name,
      openingBalance: numericToCents(a.opening_balance),
      openingDate: a.opening_date,
    }))
    const txs = (txsResult.data as TxRow[]).map(rowToTransaction)

    const { data, error } = await owner.rpc('monthly_evolution', { p_company: company, p_as_of: today, p_months: 6 })
    if (error) throw error
    const actual = (data as { month: string; cash_in: string; cash_out: string; net: string; end_balance: string }[]).map((r) => ({
      month: r.month,
      cashIn: numericToCents(r.cash_in),
      cashOut: numericToCents(r.cash_out),
      net: numericToCents(r.net),
      endBalance: numericToCents(r.end_balance),
    }))
    expect(actual).toEqual(monthlyEvolution(accounts, txs, today, 6))
  })

  it('base_projection coincide com projectCashflow/BASE_SCENARIO (série, resumo e exclusões)', async () => {
    const [accountsResult, txsResult] = await Promise.all([
      owner.from('accounts').select('id,name,opening_balance,opening_date').eq('company_id', company).order('created_at'),
      owner.from('transactions').select('*').eq('company_id', company),
    ])
    if (accountsResult.error) throw accountsResult.error
    if (txsResult.error) throw txsResult.error
    const accounts: Account[] = (accountsResult.data as { id: string; name: string; opening_balance: string; opening_date: string }[]).map((a) => ({
      id: a.id,
      name: a.name,
      openingBalance: numericToCents(a.opening_balance),
      openingDate: a.opening_date,
    }))
    const txs = (txsResult.data as TxRow[]).map(rowToTransaction)
    const expected = projectCashflow({ accounts, transactions: txs, asOf: today, horizonDays: 30, assumptions: BASE_SCENARIO })

    const { data, error } = await owner.rpc('base_projection', { p_company: company, p_as_of: today, p_days: 30 })
    if (error) throw error
    const rows = data as {
      day: string
      inflow: string
      outflow: string
      balance: string
      pressure_rank: number | null
      start_balance: string
      end_balance: string
      total_in: string
      total_out: string
      min_balance: string
      min_date: string
      first_negative_date: string | null
      negative_days: number
      last_inflow_date: string | null
      overdue_receivables_amount: string
      overdue_receivables_count: number
      beyond_horizon_amount: string
      beyond_horizon_count: number
    }[]

    const days = rows.map((r) => ({ date: r.day, inflow: numericToCents(r.inflow), outflow: numericToCents(r.outflow), balance: numericToCents(r.balance) }))
    expect(days).toEqual(expected.days.map(({ date, inflow, outflow, balance }) => ({ date, inflow, outflow, balance })))

    const first = rows[0]
    expect({
      startBalance: numericToCents(first.start_balance),
      endBalance: numericToCents(first.end_balance),
      totalIn: numericToCents(first.total_in),
      totalOut: numericToCents(first.total_out),
      minBalance: numericToCents(first.min_balance),
      minDate: first.min_date,
      firstNegativeDate: first.first_negative_date,
      negativeDays: first.negative_days,
      lastInflowDate: first.last_inflow_date,
      excluded: {
        overdueReceivables: { amount: numericToCents(first.overdue_receivables_amount), count: first.overdue_receivables_count },
        beyondHorizon: { amount: numericToCents(first.beyond_horizon_amount), count: first.beyond_horizon_count },
      },
    }).toEqual({
      startBalance: expected.startBalance,
      endBalance: expected.endBalance,
      totalIn: expected.totalIn,
      totalOut: expected.totalOut,
      minBalance: expected.minBalance,
      minDate: expected.minDate,
      firstNegativeDate: expected.firstNegativeDate,
      negativeDays: expected.negativeDays,
      lastInflowDate: expected.lastInflowDate,
      excluded: {
        overdueReceivables: expected.excluded.overdueReceivables,
        beyondHorizon: expected.excluded.beyondHorizon,
      },
    })

    const pressure = rows
      .filter((r) => r.pressure_rank !== null)
      .sort((a, b) => (a.pressure_rank ?? 0) - (b.pressure_rank ?? 0))
      .map((r) => r.day)
    expect(pressure).toEqual(expected.pressureDays.map((d) => d.date))
  })

  it('bloqueia import_transactions com 54000 depois de 10 chamadas na janela', async () => {
    const args = (i: number) => ({
      p_company: company,
      p_file_name: `rate-${i}.csv`,
      p_file_hash: 'f'.repeat(64),
      p_rows: [
        {
          kind: 'income',
          status: 'pending',
          description: `Importação ${i}`,
          account_id: account1,
          amount: '1.00',
          competence_date: today,
          due_date: today,
          source_ref: `rate:${run}:${i}`,
        },
      ],
      p_stats: { total_rows: 1, skipped: 0, errors: 0, warnings: 0 },
    })

    for (let i = 0; i < 10; i++) {
      const r = await owner.rpc('import_transactions', args(i))
      expect(r.error, `chamada ${i + 1}`).toBeNull()
    }
    const blocked = await owner.rpc('import_transactions', args(10))
    expect(blocked.error?.code).toBe('54000')
  })

  it('o cliente não chama o limite genérico (não escolhe a janela para zerar o contador)', async () => {
    const r = await owner.rpc('consume_rate_limit', { p_bucket: 'import_transactions', p_max: 10000, p_window_seconds: 1 })
    expect(r.error).not.toBeNull()
  })

  it('limite de validação da Edge Function: 30 a cada 10 minutos por usuário', async () => {
    for (let i = 0; i < 30; i++) expect((await owner.rpc('rate_limit_import_validation')).error, `chamada ${i + 1}`).toBeNull()
    expect((await owner.rpc('rate_limit_import_validation')).error?.code).toBe('54000')
  })
})

afterAll(async () => {
  if (!admin) return
  if (company) await admin.from('companies').delete().eq('id', company)
  if (userId) await admin.auth.admin.deleteUser(userId)
})

describe.runIf(!configured)('configuração', () => {
  it('pula os testes de agregados sem SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY e SUPABASE_TEST_SERVICE_ROLE_KEY', () => {
    expect(configured).toBe(false)
  })
})
