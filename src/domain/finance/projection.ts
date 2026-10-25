import type { Account, Transaction } from '@/domain/types'
import { applyPercent, formatBRL, type Cents } from '@/lib/money'
import { addDays, type ISODate } from '@/lib/dates'
import { registeredBalance } from './metrics'

/**
 * Motor único de projeção de caixa. Usado pelo Fluxo de caixa, pelos alertas e pelo Simulador —
 * por isso os três sempre concordam.
 *
 * Premissas fixas (sempre exibidas na interface):
 * 1. Saldo inicial = saldo registrado na data de referência.
 * 2. Só entram lançamentos pendentes já registrados (inclui recorrências materializadas).
 * 3. Despesas vencidas e não pagas são consideradas pagas no dia de referência (visão prudente).
 * 4. Transferências entre contas próprias não alteram o saldo consolidado e são ignoradas.
 * 5. Lançamentos cancelados são ignorados.
 */

export type ScenarioId = 'base' | 'conservative' | 'custom'

export interface ScenarioAssumptions {
  id: ScenarioId
  /** Atraso aplicado a todos os recebimentos previstos (dias). */
  receivableDelayDays: number
  /** Percentual dos recebimentos previstos desconsiderado (não é probabilidade: é uma margem de prudência escolhida pelo usuário). */
  receivableHaircutPct: number
  /** Incluir recebimentos já vencidos? Se sim, assume recebimento em `overdueAssumedInDays`. */
  includeOverdueReceivables: boolean
  overdueAssumedInDays: number
  /** Receita semanal estimada informada pelo usuário (vendas ainda não lançadas). 0 = não considerar. */
  estimatedWeeklyIncome: Cents
}

export const BASE_SCENARIO: ScenarioAssumptions = {
  id: 'base',
  receivableDelayDays: 0,
  receivableHaircutPct: 0,
  includeOverdueReceivables: false,
  overdueAssumedInDays: 0,
  estimatedWeeklyIncome: 0,
}

export const CONSERVATIVE_SCENARIO: ScenarioAssumptions = {
  id: 'conservative',
  receivableDelayDays: 7,
  receivableHaircutPct: 10,
  includeOverdueReceivables: false,
  overdueAssumedInDays: 0,
  estimatedWeeklyIncome: 0,
}

export function describeAssumptions(a: ScenarioAssumptions): string[] {
  const lines: string[] = []
  lines.push(
    a.receivableDelayDays === 0
      ? 'Recebimentos previstos entram na data de vencimento.'
      : `Recebimentos previstos entram ${a.receivableDelayDays} dia(s) após o vencimento.`,
  )
  if (a.receivableHaircutPct > 0)
    lines.push(`${a.receivableHaircutPct}% do valor de cada recebimento previsto é desconsiderado por prudência.`)
  lines.push(
    a.includeOverdueReceivables
      ? `Recebimentos já vencidos são considerados recebidos em ${a.overdueAssumedInDays} dia(s).`
      : 'Recebimentos já vencidos não são considerados (data de recebimento incerta).',
  )
  lines.push('Pagamentos vencidos e não quitados são tratados como pagos hoje.')
  if (a.estimatedWeeklyIncome > 0)
    lines.push(`Receita estimada pelo usuário de ${formatBRL(a.estimatedWeeklyIncome)} por semana, a partir de 7 dias.`)
  else lines.push('Só entram lançamentos registrados; vendas futuras ainda não lançadas não aparecem.')
  return lines
}

export interface ProjectedEvent {
  /** null para eventos virtuais do simulador. */
  txId: string | null
  description: string
  direction: 'in' | 'out'
  amount: Cents
  originalDate: ISODate
  effectiveDate: ISODate
  adjustment?: string
  virtual?: boolean
}

export interface ProjectionDay {
  date: ISODate
  inflow: Cents
  outflow: Cents
  balance: Cents
  events: ProjectedEvent[]
}

export interface ProjectionInput {
  accounts: Account[]
  transactions: Transaction[]
  asOf: ISODate
  horizonDays: number
  assumptions: ScenarioAssumptions
  /** Eventos adicionais (simulador). Nunca são gravados como lançamentos. */
  extraEvents?: ProjectedEvent[]
  /** Novas datas para lançamentos existentes (simulador: renegociação/atraso). */
  dateOverrides?: Map<string, { date: ISODate; reason: string }>
}

export interface Projection {
  asOf: ISODate
  endDate: ISODate
  horizonDays: number
  assumptions: ScenarioAssumptions
  startBalance: Cents
  endBalance: Cents
  totalIn: Cents
  totalOut: Cents
  minBalance: Cents
  minDate: ISODate
  firstNegativeDate: ISODate | null
  negativeDays: number
  days: ProjectionDay[]
  events: ProjectedEvent[]
  /** Dias com maior saída líquida (pressão financeira). */
  pressureDays: ProjectionDay[]
  excluded: {
    overdueReceivables: { amount: Cents; count: number }
    haircut: Cents
    beyondHorizon: { amount: Cents; count: number }
  }
  /** Data do último recebimento considerado: depois dela, a projeção não tem entradas registradas. */
  lastInflowDate: ISODate | null
}

export function projectCashflow(input: ProjectionInput): Projection {
  const { accounts, transactions, asOf, horizonDays, assumptions: a } = input
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 366)
    throw new RangeError('Horizonte de projeção deve estar entre 1 e 366 dias')
  const endDate = addDays(asOf, horizonDays - 1)
  const startBalance = registeredBalance(accounts, transactions, asOf)

  const events: ProjectedEvent[] = []
  const excluded = {
    overdueReceivables: { amount: 0, count: 0 },
    haircut: 0,
    beyondHorizon: { amount: 0, count: 0 },
  }

  for (const tx of transactions) {
    if (tx.status !== 'pending' || tx.kind === 'transfer') continue
    const override = input.dateOverrides?.get(tx.id)
    const baseDate = override?.date ?? tx.dueDate
    let effectiveDate = baseDate
    let amount: Cents = tx.amount
    const notes: string[] = []
    if (override) notes.push(override.reason)

    if (tx.kind === 'income') {
      if (baseDate < asOf) {
        if (!a.includeOverdueReceivables) {
          excluded.overdueReceivables.amount += tx.amount
          excluded.overdueReceivables.count++
          continue
        }
        effectiveDate = addDays(asOf, a.overdueAssumedInDays)
        notes.push(`vencido em ${baseDate}; recebimento assumido`)
      } else if (a.receivableDelayDays) {
        effectiveDate = addDays(baseDate, a.receivableDelayDays)
        notes.push(`atraso de ${a.receivableDelayDays} dia(s)`)
      }
    } else if (baseDate < asOf) {
      effectiveDate = asOf
      notes.push('vencido; considerado pago hoje')
    }

    if (effectiveDate > endDate) {
      excluded.beyondHorizon.amount += tx.amount
      excluded.beyondHorizon.count++
      continue
    }
    if (tx.kind === 'income' && a.receivableHaircutPct > 0) {
      const cut = applyPercent(tx.amount, a.receivableHaircutPct)
      amount -= cut
      excluded.haircut += cut
      notes.push(`−${a.receivableHaircutPct}% por prudência`)
    }
    events.push({
      txId: tx.id,
      description: tx.description,
      direction: tx.kind === 'income' ? 'in' : 'out',
      amount,
      originalDate: tx.dueDate,
      effectiveDate,
      adjustment: notes.length ? notes.join('; ') : undefined,
    })
  }

  if (a.estimatedWeeklyIncome > 0) {
    for (let d = addDays(asOf, 7); d <= endDate; d = addDays(d, 7)) {
      events.push({
        txId: null,
        description: 'Receita estimada (premissa do usuário)',
        direction: 'in',
        amount: a.estimatedWeeklyIncome,
        originalDate: d,
        effectiveDate: d,
        virtual: true,
      })
    }
  }

  for (const ev of input.extraEvents ?? []) {
    const effectiveDate = ev.effectiveDate < asOf ? asOf : ev.effectiveDate
    if (effectiveDate > endDate) continue
    events.push({ ...ev, effectiveDate, virtual: true })
  }

  const byDate = new Map<ISODate, ProjectedEvent[]>()
  for (const ev of events) {
    const list = byDate.get(ev.effectiveDate)
    if (list) list.push(ev)
    else byDate.set(ev.effectiveDate, [ev])
  }

  const days: ProjectionDay[] = []
  let balance = startBalance
  let minBalance = Number.POSITIVE_INFINITY
  let minDate = asOf
  let firstNegativeDate: ISODate | null = null
  let negativeDays = 0
  let totalIn = 0
  let totalOut = 0
  let lastInflowDate: ISODate | null = null

  for (let i = 0; i < horizonDays; i++) {
    const date = addDays(asOf, i)
    const dayEvents = (byDate.get(date) ?? []).sort((x, y) => y.amount - x.amount)
    let inflow = 0
    let outflow = 0
    for (const ev of dayEvents) {
      if (ev.direction === 'in') inflow += ev.amount
      else outflow += ev.amount
    }
    if (inflow > 0) lastInflowDate = date
    balance += inflow - outflow
    totalIn += inflow
    totalOut += outflow
    if (balance < minBalance) {
      minBalance = balance
      minDate = date
    }
    if (balance < 0) {
      negativeDays++
      firstNegativeDate ??= date
    }
    days.push({ date, inflow, outflow, balance, events: dayEvents })
  }

  const pressureDays = days
    .filter((d) => d.outflow - d.inflow > 0)
    .sort((x, y) => y.outflow - y.inflow - (x.outflow - x.inflow))
    .slice(0, 3)

  return {
    asOf,
    endDate,
    horizonDays,
    assumptions: a,
    startBalance,
    endBalance: balance,
    totalIn,
    totalOut,
    minBalance,
    minDate,
    firstNegativeDate,
    negativeDays,
    days,
    events: events.sort((x, y) => (x.effectiveDate < y.effectiveDate ? -1 : x.effectiveDate > y.effectiveDate ? 1 : 0)),
    pressureDays,
    excluded,
    lastInflowDate,
  }
}

export interface ScenarioComparison {
  minBalanceDelta: Cents
  endBalanceDelta: Cents
  totalInDelta: Cents
  totalOutDelta: Cents
  /** Datas em que um cenário fica negativo e o outro não. */
  newNegativeDate: ISODate | null
}

export function compareProjections(reference: Projection, alternative: Projection): ScenarioComparison {
  return {
    minBalanceDelta: alternative.minBalance - reference.minBalance,
    endBalanceDelta: alternative.endBalance - reference.endBalance,
    totalInDelta: alternative.totalIn - reference.totalIn,
    totalOutDelta: alternative.totalOut - reference.totalOut,
    newNegativeDate:
      alternative.firstNegativeDate && !reference.firstNegativeDate ? alternative.firstNegativeDate : null,
  }
}
