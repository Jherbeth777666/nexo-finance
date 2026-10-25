import { acc, cats, tx } from './testkit'
import { accountBalances, delinquency, monthlyEvolution, payables, periodSummary, receivables, registeredBalance } from './metrics'
import { BASE_SCENARIO, CONSERVATIVE_SCENARIO, projectCashflow } from './projection'
import { DecisionError, simulate } from './simulation'
import { detectAlerts, findSuspectedDuplicates } from './alerts'

const asOf = '2026-03-15'

describe('saldos', () => {
  it('saldo registrado = abertura + liquidados até a data', () => {
    const txs = [
      tx({ kind: 'income', amount: 50_000, dueDate: '2026-02-10' }),
      tx({ kind: 'expense', amount: 20_000, dueDate: '2026-03-01' }),
      tx({ kind: 'expense', amount: 99_999, status: 'pending', dueDate: '2026-03-10' }), // pendente não conta
      tx({ kind: 'income', amount: 7_000, dueDate: '2026-03-20' }), // depois do asOf
      tx({ kind: 'income', amount: 1_000, status: 'cancelled', dueDate: '2026-03-01' }),
    ]
    expect(registeredBalance([acc()], txs, asOf)).toBe(100_000 + 50_000 - 20_000)
  })

  it('ignora liquidações anteriores ao saldo de abertura', () => {
    const txs = [tx({ kind: 'income', amount: 50_000, dueDate: '2025-12-31' })]
    expect(registeredBalance([acc()], txs, asOf)).toBe(100_000)
  })

  it('transferência move entre contas sem alterar o consolidado', () => {
    const accounts = [acc(), acc({ id: 'acc2', name: 'Caixa', openingBalance: 10_000 })]
    const txs = [tx({ kind: 'transfer', amount: 4_000, accountId: 'acc2', toAccountId: 'acc1', dueDate: '2026-03-02' })]
    const [a1, a2] = accountBalances(accounts, txs, asOf)
    expect(a1.balance).toBe(104_000)
    expect(a2.balance).toBe(6_000)
    expect(registeredBalance(accounts, txs, asOf)).toBe(110_000)
  })
})

describe('receitas, despesas e resultado', () => {
  const txs = [
    tx({ kind: 'income', amount: 30_000, competenceDate: '2026-03-02', dueDate: '2026-03-02' }),
    // venda de março recebida em abril: entra no resultado de março, não no caixa de março
    tx({ kind: 'income', amount: 10_000, status: 'pending', competenceDate: '2026-03-05', dueDate: '2026-04-05' }),
    // despesa de fevereiro paga em março: entra no caixa de março, não no resultado
    tx({ kind: 'expense', amount: 8_000, competenceDate: '2026-02-25', dueDate: '2026-03-03', settledDate: '2026-03-03' }),
    tx({ kind: 'expense', amount: 5_000, competenceDate: '2026-03-10', dueDate: '2026-03-10' }),
    tx({ kind: 'transfer', amount: 50_000, toAccountId: 'acc2', dueDate: '2026-03-04' }),
  ]
  const s = periodSummary(txs, '2026-03-01', '2026-03-31')
  it('regime de caixa', () => {
    expect(s.cashIn.value).toBe(30_000)
    expect(s.cashOut.value).toBe(13_000)
  })
  it('regime de competência e resultado operacional', () => {
    expect(s.revenue.value).toBe(40_000)
    expect(s.expenses.value).toBe(5_000)
    expect(s.operatingResult).toBe(35_000)
  })
  it('transferências nunca entram em receitas ou despesas', () => {
    const all = [...s.cashIn.ids, ...s.cashOut.ids, ...s.revenue.ids, ...s.expenses.ids]
    expect(all).not.toContain(txs[4].id)
  })
  it('rastreia os lançamentos de cada indicador', () => {
    expect(s.cashIn.ids).toEqual([txs[0].id])
    expect(s.cashOut.count).toBe(2)
  })
})

describe('contas a pagar e receber', () => {
  const txs = [
    tx({ kind: 'income', amount: 1_000, status: 'pending', dueDate: '2026-03-10' }), // vencida
    tx({ kind: 'income', amount: 2_000, status: 'pending', dueDate: '2026-03-15' }), // hoje: não vencida
    tx({ kind: 'income', amount: 3_000, status: 'pending', dueDate: '2026-04-30' }),
    tx({ kind: 'expense', amount: 500, status: 'pending', dueDate: '2026-03-20' }),
    tx({ kind: 'expense', amount: 700, status: 'settled', dueDate: '2026-03-01' }),
  ]
  it('separa vencidos e a vencer', () => {
    const r = receivables(txs, asOf)
    expect(r.total.value).toBe(6_000)
    expect(r.overdue.value).toBe(1_000)
    expect(r.dueNext7.value).toBe(2_000)
    expect(payables(txs, asOf).total.value).toBe(500)
  })
  it('taxa de atraso sobre vencimentos da janela', () => {
    const d = delinquency([...txs, tx({ kind: 'income', amount: 3_000, dueDate: '2026-02-01' })], asOf)
    expect(d.overdue.value).toBe(1_000)
    expect(d.dueInWindow.value).toBe(4_000)
    expect(d.rate).toBe(25)
  })
  it('taxa indisponível sem vencimentos na janela', () => {
    expect(delinquency([], asOf).rate).toBeNull()
  })
})

describe('projeção de caixa', () => {
  const accounts = [acc({ openingBalance: 10_000 })]
  const txs = [
    tx({ kind: 'income', amount: 20_000, status: 'pending', dueDate: '2026-03-18' }),
    tx({ kind: 'expense', amount: 25_000, status: 'pending', dueDate: '2026-03-20' }),
    tx({ kind: 'expense', amount: 3_000, status: 'pending', dueDate: '2026-03-01' }), // vencida → hoje
    tx({ kind: 'income', amount: 4_000, status: 'pending', dueDate: '2026-03-02' }), // vencida
    tx({ kind: 'income', amount: 9_000, status: 'pending', dueDate: '2026-06-01' }), // fora do horizonte
  ]
  const base = projectCashflow({ accounts, transactions: txs, asOf, horizonDays: 30, assumptions: BASE_SCENARIO })

  it('parte do saldo registrado e soma os pendentes do horizonte', () => {
    expect(base.startBalance).toBe(10_000)
    expect(base.days).toHaveLength(30)
    expect(base.days[0].balance).toBe(7_000) // despesa vencida considerada paga hoje
    expect(base.endBalance).toBe(10_000 - 3_000 + 20_000 - 25_000)
  })
  it('identifica saldo mínimo e primeira data negativa', () => {
    expect(base.minBalance).toBe(2_000)
    expect(base.firstNegativeDate).toBeNull()
  })
  it('exclui recebimentos vencidos no cenário-base e informa', () => {
    expect(base.excluded.overdueReceivables).toEqual({ amount: 4_000, count: 1 })
    expect(base.excluded.beyondHorizon.count).toBe(1)
  })
  it('cenário conservador atrasa e reduz recebimentos', () => {
    const c = projectCashflow({ accounts, transactions: txs, asOf, horizonDays: 30, assumptions: CONSERVATIVE_SCENARIO })
    const ev = c.events.find((e) => e.direction === 'in')!
    expect(ev.effectiveDate).toBe('2026-03-25')
    expect(ev.amount).toBe(18_000)
    expect(c.excluded.haircut).toBe(2_000)
    // pagamento de 25.000 em 20/03 antes do recebimento atrasado → negativo
    expect(c.firstNegativeDate).toBe('2026-03-20')
    expect(c.minBalance).toBe(7_000 - 25_000)
  })
  it('pode incluir recebimentos vencidos com data assumida', () => {
    const p = projectCashflow({
      accounts,
      transactions: txs,
      asOf,
      horizonDays: 30,
      assumptions: {
        id: 'custom',
        receivableDelayDays: 0,
        receivableHaircutPct: 0,
        includeOverdueReceivables: true,
        overdueAssumedInDays: 5,
        estimatedWeeklyIncome: 0,
      },
    })
    expect(p.events.find((e) => e.originalDate === '2026-03-02')?.effectiveDate).toBe('2026-03-20')
  })
  it('receita semanal estimada é premissa explícita e virtual', () => {
    const p = projectCashflow({
      accounts,
      transactions: txs,
      asOf,
      horizonDays: 30,
      assumptions: { ...BASE_SCENARIO, id: 'custom', estimatedWeeklyIncome: 1_000 },
    })
    const est = p.events.filter((e) => e.virtual)
    expect(est.map((e) => e.effectiveDate)).toEqual(['2026-03-22', '2026-03-29', '2026-04-05', '2026-04-12'])
    expect(p.endBalance - base.endBalance).toBe(4_000)
  })
  it('valida o horizonte', () => {
    expect(() => projectCashflow({ accounts, transactions: [], asOf, horizonDays: 0, assumptions: BASE_SCENARIO })).toThrow()
  })
  it('horizontes de 7, 30 e 90 dias', () => {
    for (const h of [7, 30, 90]) {
      const p = projectCashflow({ accounts, transactions: txs, asOf, horizonDays: h, assumptions: BASE_SCENARIO })
      expect(p.days).toHaveLength(h)
    }
  })
  it('não muta os lançamentos', () => {
    const copy = JSON.stringify(txs)
    projectCashflow({ accounts, transactions: txs, asOf, horizonDays: 30, assumptions: CONSERVATIVE_SCENARIO })
    expect(JSON.stringify(txs)).toBe(copy)
  })
})

describe('simulador', () => {
  const accounts = [acc({ openingBalance: 10_000 })]
  const payable = tx({ id: 'p1', kind: 'expense', amount: 12_000, status: 'pending', dueDate: '2026-03-20' })
  const receivable = tx({ id: 'r1', kind: 'income', amount: 6_000, status: 'pending', dueDate: '2026-03-18' })
  const txs = [payable, receivable]
  const run = (decisions: Parameters<typeof simulate>[0]['decisions']) => simulate({ accounts, transactions: txs, asOf, horizonDays: 30, decisions })

  it('sem decisões, alternativo = atual', () => {
    const r = run([])
    expect(r.comparison.endBalanceDelta).toBe(0)
  })
  it('contratação gera saída mensal e reduz o saldo mínimo', () => {
    const r = run([{ id: 'd', type: 'hire', label: 'Auxiliar', monthlyCost: 5_000, startDate: '2026-03-16' }])
    expect(r.comparison.endBalanceDelta).toBe(-5_000)
    expect(r.alternative.minBalance).toBe(r.current.minBalance - 5_000)
  })
  it('compra parcelada soma exatamente o total', () => {
    const r = simulate({
      accounts,
      transactions: txs,
      asOf,
      horizonDays: 120,
      decisions: [{ id: 'd', type: 'equipment', label: 'Forno', amount: 10_000, firstDate: '2026-03-16', installments: 3 }],
    })
    const parcels = r.alternative.events.filter((e) => e.virtual)
    expect(parcels.map((p) => p.amount)).toEqual([3_334, 3_333, 3_333])
  })
  it('renegociação move o vencimento sem alterar o lançamento real', () => {
    const before = JSON.stringify(txs)
    const r = run([{ id: 'd', type: 'renegotiate', label: 'Renegociar', txId: 'p1', newDate: '2026-04-05' }])
    expect(r.alternative.events.find((e) => e.txId === 'p1')?.effectiveDate).toBe('2026-04-05')
    expect(JSON.stringify(txs)).toBe(before)
    expect(payable.dueDate).toBe('2026-03-20')
  })
  it('atraso de recebimento pode criar data crítica', () => {
    const r = run([{ id: 'd', type: 'shift_receivable', label: 'Atraso', txId: 'r1', days: 7 }])
    expect(r.criticalDates[0]).toBe('2026-03-20')
    expect(r.comparison.newNegativeDate).toBe('2026-03-20')
  })
  it('rejeita decisões inválidas', () => {
    expect(() => run([{ id: 'd', type: 'renegotiate', label: 'x', txId: 'r1', newDate: '2026-04-01' }])).toThrow(DecisionError)
    expect(() => run([{ id: 'd', type: 'hire', label: 'x', monthlyCost: 0, startDate: '2026-03-16' }])).toThrow(DecisionError)
    expect(() => run([{ id: 'd', type: 'equipment', label: 'x', amount: 100, firstDate: '2026-03-16', installments: 0 }])).toThrow(DecisionError)
  })
  it('usa o mesmo motor da projeção', () => {
    const r = run([])
    const p = projectCashflow({ accounts, transactions: txs, asOf, horizonDays: 30, assumptions: BASE_SCENARIO })
    expect(r.current.endBalance).toBe(p.endBalance)
    expect(r.current.minBalance).toBe(p.minBalance)
  })
})

describe('alertas', () => {
  it('informa dados insuficientes para comparação', () => {
    const txs = [tx({ kind: 'expense', amount: 1_000, competenceDate: '2026-03-10' })]
    const run = detectAlerts([acc()], txs, cats, asOf)
    expect(run.skipped.map((s) => s.reason)[0]).toMatch(/Dados insuficientes/)
    expect(run.alerts.find((a) => a.rule === 'expense_increase')).toBeUndefined()
  })

  it('detecta aumento de despesa por categoria com evidências', () => {
    const txs = [
      tx({ kind: 'expense', amount: 100_000, categoryId: 'energia', competenceDate: '2026-03-10' }),
      tx({ kind: 'expense', amount: 50_000, categoryId: 'energia', competenceDate: '2026-02-05' }),
      tx({ kind: 'expense', amount: 50_000, categoryId: 'energia', competenceDate: '2026-01-05' }),
      tx({ kind: 'expense', amount: 50_000, categoryId: 'energia', competenceDate: '2025-12-05' }),
    ]
    const run = detectAlerts([acc({ openingDate: '2025-11-01' })], txs, cats, asOf)
    const a = run.alerts.find((x) => x.rule === 'expense_increase')!
    expect(a.title).toMatch(/Energia subiram 100%/)
    expect(a.impact).toBe(-50_000)
    expect(a.transactionIds).toEqual([txs[0].id])
  })

  it('não alerta variação abaixo do limite configurado', () => {
    const txs = [
      tx({ kind: 'expense', amount: 55_000, categoryId: 'energia', competenceDate: '2026-03-10' }),
      tx({ kind: 'expense', amount: 50_000, categoryId: 'energia', competenceDate: '2026-02-05' }),
      tx({ kind: 'expense', amount: 50_000, categoryId: 'energia', competenceDate: '2026-01-05' }),
      tx({ kind: 'expense', amount: 50_000, categoryId: 'energia', competenceDate: '2025-12-05' }),
    ]
    expect(detectAlerts([acc()], txs, cats, asOf).alerts.some((a) => a.rule === 'expense_increase')).toBe(false)
  })

  it('agrupa recebimentos vencidos em um único alerta', () => {
    const txs = [
      tx({ kind: 'income', amount: 1_000, status: 'pending', dueDate: '2026-03-01', categoryId: 'vendas' }),
      tx({ kind: 'income', amount: 2_000, status: 'pending', dueDate: '2026-03-05', categoryId: 'vendas' }),
    ]
    const alerts = detectAlerts([acc()], txs, cats, asOf).alerts.filter((a) => a.rule === 'overdue_receivables')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].impact).toBe(3_000)
    expect(alerts[0].transactionIds).toHaveLength(2)
  })

  it('fingerprint estável entre execuções', () => {
    const txs = [tx({ kind: 'income', amount: 1_000, status: 'pending', dueDate: '2026-03-01' })]
    const a = detectAlerts([acc()], txs, cats, asOf).alerts.map((x) => x.fingerprint)
    const b = detectAlerts([acc()], txs, cats, asOf).alerts.map((x) => x.fingerprint)
    expect(a).toEqual(b)
  })

  it('detecta risco de caixa negativo pelo mesmo motor', () => {
    const txs = [tx({ kind: 'expense', amount: 150_000, status: 'pending', dueDate: '2026-03-25' })]
    const a = detectAlerts([acc()], txs, cats, asOf).alerts.find((x) => x.rule === 'negative_cash_risk')!
    expect(a.severity).toBe('critical')
    expect(a.title).toMatch(/25\/03\/2026/)
    expect(a.impact).toBe(-50_000)
  })

  it('detecta concentração de pagamentos', () => {
    const txs = [
      tx({ kind: 'expense', amount: 400_000, status: 'pending', dueDate: '2026-03-20' }),
      tx({ kind: 'expense', amount: 300_000, status: 'pending', dueDate: '2026-03-22' }),
      tx({ kind: 'expense', amount: 100_000, status: 'pending', dueDate: '2026-04-10' }),
    ]
    const a = detectAlerts([acc({ openingBalance: 5_000_000 })], txs, cats, asOf).alerts.find((x) => x.rule === 'payment_concentration')!
    expect(a.title).toMatch(/^88%/)
    expect(a.transactionIds).toHaveLength(2)
  })

  it('duplicatas são suspeitas, não certezas; recorrências não contam', () => {
    const a = tx({ kind: 'expense', amount: 1_000, description: 'Manutenção', competenceDate: '2026-03-01' })
    const b = tx({ kind: 'expense', amount: 1_000, description: 'manutencao', competenceDate: '2026-03-03' })
    const c = tx({ kind: 'expense', amount: 1_000, description: 'Manutenção', competenceDate: '2026-03-20' })
    const r1 = tx({ kind: 'expense', amount: 500, description: 'Aluguel', competenceDate: '2026-03-01', recurrenceId: 'r' })
    const r2 = tx({ kind: 'expense', amount: 500, description: 'Aluguel', competenceDate: '2026-03-02', recurrenceId: 'r' })
    const pairs = findSuspectedDuplicates([a, b, c, r1, r2], 3)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].map((t) => t.id)).toEqual([a.id, b.id])
  })

  it('aponta inconsistências de dados', () => {
    const txs = [tx({ kind: 'expense', amount: 1_000, categoryId: null }), tx({ kind: 'expense', amount: 1_000, settledDate: '2026-04-01' })]
    const a = detectAlerts([acc()], txs, cats, asOf).alerts.find((x) => x.rule === 'data_inconsistency')!
    expect(a.transactionIds).toHaveLength(2)
    expect(a.severity).toBe('warning')
  })

  it('sem dados, nenhum alerta é inventado', () => {
    const run = detectAlerts([acc({ openingBalance: 10_000_000 })], [], cats, asOf)
    expect(run.alerts).toEqual([])
  })
})

describe('evolução mensal', () => {
  it('agrega por mês sem transferências', () => {
    const txs = [
      tx({ kind: 'income', amount: 1_000, dueDate: '2026-02-10' }),
      tx({ kind: 'expense', amount: 400, dueDate: '2026-03-10' }),
      tx({ kind: 'transfer', amount: 9_999, toAccountId: 'x', dueDate: '2026-03-11' }),
    ]
    const pts = monthlyEvolution([acc()], txs, asOf, 3)
    expect(pts.map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03'])
    expect(pts[1].cashIn).toBe(1_000)
    expect(pts[2].cashOut).toBe(400)
  })
})
