import type { Account, Transaction } from '@/domain/types'
import type { Cents } from '@/lib/money'
import { addDays, type ISODate } from '@/lib/dates'

/**
 * Indicadores determinísticos. Cada função documenta a definição exibida na interface
 * (ver METRIC_DEFINITIONS) e devolve os ids que sustentam o valor (rastreabilidade).
 */

export interface TracedValue {
  value: Cents
  count: number
  ids: string[]
}

const empty = (): TracedValue => ({ value: 0, count: 0, ids: [] })

function add(t: TracedValue, tx: Transaction, amount = tx.amount) {
  t.value += amount
  t.count += 1
  t.ids.push(tx.id)
}

export const isActive = (tx: Transaction) => tx.status !== 'cancelled'
export const isPendingIncome = (tx: Transaction) => tx.kind === 'income' && tx.status === 'pending'
export const isPendingExpense = (tx: Transaction) => tx.kind === 'expense' && tx.status === 'pending'
export const isOverdue = (tx: Transaction, asOf: ISODate) => tx.status === 'pending' && tx.dueDate < asOf

/** Efeito de um lançamento liquidado sobre o saldo de uma conta. */
export function accountEffect(tx: Transaction, accountId: string): Cents {
  if (tx.status !== 'settled') return 0
  if (tx.kind === 'income') return tx.accountId === accountId ? tx.amount : 0
  if (tx.kind === 'expense') return tx.accountId === accountId ? -tx.amount : 0
  // transferência
  let effect = 0
  if (tx.accountId === accountId) effect -= tx.amount
  if (tx.toAccountId === accountId) effect += tx.amount
  return effect
}

export interface AccountBalance {
  account: Account
  balance: Cents
  settledCount: number
}

/**
 * Saldo registrado = saldo de abertura + lançamentos liquidados entre a data de abertura e `asOf`.
 * Liquidações anteriores à abertura já estão no saldo de abertura e são ignoradas.
 */
export function accountBalances(accounts: Account[], txs: Transaction[], asOf: ISODate): AccountBalance[] {
  return accounts.map((account) => {
    let balance = account.openingDate <= asOf ? account.openingBalance : 0
    let settledCount = 0
    for (const tx of txs) {
      if (tx.status !== 'settled' || !tx.settledDate) continue
      if (tx.settledDate < account.openingDate || tx.settledDate > asOf) continue
      const e = accountEffect(tx, account.id)
      if (e !== 0) {
        balance += e
        settledCount++
      }
    }
    return { account, balance, settledCount }
  })
}

export function registeredBalance(accounts: Account[], txs: Transaction[], asOf: ISODate): Cents {
  return accountBalances(accounts, txs, asOf).reduce((s, b) => s + b.balance, 0)
}

export interface OpenItems {
  total: TracedValue
  overdue: TracedValue
  dueNext7: TracedValue
  dueNext30: TracedValue
}

function openItems(txs: Transaction[], asOf: ISODate, pred: (t: Transaction) => boolean): OpenItems {
  const r: OpenItems = { total: empty(), overdue: empty(), dueNext7: empty(), dueNext30: empty() }
  const d7 = addDays(asOf, 6)
  const d30 = addDays(asOf, 29)
  for (const tx of txs) {
    if (!pred(tx)) continue
    add(r.total, tx)
    if (tx.dueDate < asOf) add(r.overdue, tx)
    else {
      if (tx.dueDate <= d7) add(r.dueNext7, tx)
      if (tx.dueDate <= d30) add(r.dueNext30, tx)
    }
  }
  return r
}

export const receivables = (txs: Transaction[], asOf: ISODate) => openItems(txs, asOf, isPendingIncome)
export const payables = (txs: Transaction[], asOf: ISODate) => openItems(txs, asOf, isPendingExpense)

export interface PeriodSummary {
  start: ISODate
  end: ISODate
  /** Regime de caixa: entradas liquidadas no período. */
  cashIn: TracedValue
  /** Regime de caixa: saídas liquidadas no período. */
  cashOut: TracedValue
  /** Regime de competência: receitas do período (liquidadas ou não). */
  revenue: TracedValue
  /** Regime de competência: despesas do período (liquidadas ou não). */
  expenses: TracedValue
  /** revenue − expenses. NÃO é lucro contábil. */
  operatingResult: Cents
}

export function periodSummary(txs: Transaction[], start: ISODate, end: ISODate): PeriodSummary {
  const s: PeriodSummary = {
    start,
    end,
    cashIn: empty(),
    cashOut: empty(),
    revenue: empty(),
    expenses: empty(),
    operatingResult: 0,
  }
  for (const tx of txs) {
    if (!isActive(tx) || tx.kind === 'transfer') continue
    if (tx.status === 'settled' && tx.settledDate && tx.settledDate >= start && tx.settledDate <= end) {
      add(tx.kind === 'income' ? s.cashIn : s.cashOut, tx)
    }
    if (tx.competenceDate >= start && tx.competenceDate <= end) {
      add(tx.kind === 'income' ? s.revenue : s.expenses, tx)
    }
  }
  s.operatingResult = s.revenue.value - s.expenses.value
  return s
}

export interface Delinquency {
  /** Valor vencido e não recebido. */
  overdue: TracedValue
  /** Recebimentos com vencimento nos últimos `windowDays` dias (base de comparação). */
  dueInWindow: TracedValue
  /** overdue / dueInWindow em %, ou null se não houve vencimentos na janela. */
  rate: number | null
  windowDays: number
}

/** Atraso de recebimentos: dos valores que venceram nos últimos N dias, quanto segue em aberto. */
export function delinquency(txs: Transaction[], asOf: ISODate, windowDays = 90): Delinquency {
  const from = addDays(asOf, -windowDays)
  const overdue = empty()
  const due = empty()
  for (const tx of txs) {
    if (tx.kind !== 'income' || !isActive(tx)) continue
    if (tx.dueDate >= from && tx.dueDate < asOf) {
      add(due, tx)
      if (tx.status === 'pending') add(overdue, tx)
    }
  }
  return {
    overdue,
    dueInWindow: due,
    rate: due.value > 0 ? (overdue.value / due.value) * 100 : null,
    windowDays,
  }
}

export interface MonthPoint {
  month: string // AAAA-MM
  cashIn: Cents
  cashOut: Cents
  net: Cents
  endBalance: Cents
}

/** Evolução mensal em regime de caixa (dados agregados — o gráfico nunca recebe lançamentos brutos). */
export function monthlyEvolution(accounts: Account[], txs: Transaction[], asOf: ISODate, months = 6): MonthPoint[] {
  const [y, m] = asOf.split('-').map(Number)
  const keys: string[] = []
  for (let i = months - 1; i >= 0; i--) {
    const total = y * 12 + (m - 1) - i
    keys.push(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`)
  }
  const buckets = new Map(keys.map((k) => [k, { cashIn: 0, cashOut: 0 }]))
  for (const tx of txs) {
    if (tx.status !== 'settled' || !tx.settledDate || tx.kind === 'transfer' || tx.settledDate > asOf) continue
    const b = buckets.get(tx.settledDate.slice(0, 7))
    if (!b) continue
    if (tx.kind === 'income') b.cashIn += tx.amount
    else b.cashOut += tx.amount
  }
  return keys.map((k) => {
    const [ky, km] = k.split('-').map(Number)
    const lastDay = new Date(Date.UTC(ky, km, 0)).toISOString().slice(0, 10)
    const b = buckets.get(k)!
    return {
      month: k,
      cashIn: b.cashIn,
      cashOut: b.cashOut,
      net: b.cashIn - b.cashOut,
      endBalance: registeredBalance(accounts, txs, lastDay < asOf ? lastDay : asOf),
    }
  })
}

/** Definições exibidas ao lado de cada indicador. Fonte única de verdade para textos de definição. */
export const METRIC_DEFINITIONS = {
  registeredBalance:
    'Soma dos saldos de abertura das contas mais todos os lançamentos liquidados até a data de referência. Transferências entre contas próprias não alteram o total.',
  receivables: 'Receitas com situação "pendente", vencidas ou a vencer.',
  payables: 'Despesas com situação "pendente", vencidas ou a vencer.',
  overdue: 'Lançamentos pendentes cujo vencimento é anterior à data de referência.',
  cashIn: 'Regime de caixa: receitas efetivamente recebidas (data de liquidação) no período.',
  cashOut: 'Regime de caixa: despesas efetivamente pagas (data de liquidação) no período.',
  operatingResult:
    'Regime de competência simplificado: receitas menos despesas com competência no período, liquidadas ou não. Exclui transferências. Não é lucro contábil e não substitui a apuração do seu contador.',
  delinquency: 'Dos recebimentos que venceram nos últimos 90 dias, a parcela que continua em aberto.',
  projectedCash:
    'Saldo registrado hoje somado aos recebimentos e pagamentos pendentes até o fim do horizonte, segundo as premissas do cenário. É uma estimativa, não uma garantia.',
} as const
