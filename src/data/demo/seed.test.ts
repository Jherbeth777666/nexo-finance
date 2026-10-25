import { buildDemoDataset } from './seed'
import { detectAlerts } from '@/domain/finance/alerts'
import { registeredBalance } from '@/domain/finance/metrics'
import { BASE_SCENARIO, CONSERVATIVE_SCENARIO, projectCashflow } from '@/domain/finance/projection'
import { formatBRL } from '@/lib/money'

// A demonstração precisa funcionar em qualquer data: testamos vários "hojes".
const anchors = ['2026-10-24', '2026-01-02', '2026-02-27', '2027-07-15']

describe.each(anchors)('dados de demonstração em %s', (today) => {
  const ds = buildDemoDataset(today)
  const run = detectAlerts(ds.accounts, ds.transactions, ds.categories, today)
  const rules = run.alerts.map((a) => a.rule)

  it('é determinístico', () => {
    expect(JSON.stringify(buildDemoDataset(today))).toBe(JSON.stringify(ds))
  })

  it('identifica todos os nomes como fictícios ou genéricos', () => {
    expect(ds.company.isDemo).toBe(true)
    expect(ds.company.name).toMatch(/fictícia/)
    for (const t of ds.transactions) {
      if (t.counterparty && /\b(Ltda|S\.A\.)/.test(t.counterparty)) throw new Error(t.counterparty)
    }
  })

  it('tem histórico suficiente para comparações', () => {
    expect(run.skipped).toEqual([])
  })

  it('demonstra as situações previstas', () => {
    expect(rules).toEqual(
      expect.arrayContaining(['expense_increase', 'overdue_receivables', 'overdue_payables', 'payment_concentration', 'suspected_duplicates', 'data_inconsistency']),
    )
  })

  it('lançamentos são válidos', () => {
    for (const t of ds.transactions) {
      expect(t.amount).toBeGreaterThan(0)
      expect(Number.isInteger(t.amount)).toBe(true)
      if (t.status === 'settled') expect(t.settledDate! <= today).toBe(true)
      if (t.kind === 'transfer') expect(t.toAccountId).toBeTruthy()
    }
  })

  it('resumo (para calibrar a demonstração)', () => {
    const base = projectCashflow({ accounts: ds.accounts, transactions: ds.transactions, asOf: today, horizonDays: 90, assumptions: BASE_SCENARIO })
    const cons = projectCashflow({ accounts: ds.accounts, transactions: ds.transactions, asOf: today, horizonDays: 30, assumptions: CONSERVATIVE_SCENARIO })
    if (process.env.DEMO_SUMMARY)
      console.log(today, {
        n: ds.transactions.length,
        saldo: formatBRL(registeredBalance(ds.accounts, ds.transactions, today)),
        min90: `${formatBRL(base.minBalance)} @ ${base.minDate}`,
        neg90: base.firstNegativeDate,
        consMin30: `${formatBRL(cons.minBalance)} @ ${cons.minDate}`,
        alerts: run.alerts.map((a) => `${a.severity}:${a.title}`),
      })
    expect(base.days).toHaveLength(90)
  })
})
