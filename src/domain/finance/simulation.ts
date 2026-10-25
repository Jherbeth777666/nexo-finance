import type { Account, Transaction } from '@/domain/types'
import type { Cents } from '@/lib/money'
import { addDays, addMonths, type ISODate } from '@/lib/dates'
import {
  BASE_SCENARIO,
  compareProjections,
  projectCashflow,
  type ProjectedEvent,
  type Projection,
  type ScenarioAssumptions,
  type ScenarioComparison,
} from './projection'

/**
 * Simulador de decisões. Converte decisões em eventos virtuais e novas datas, e roda o MESMO motor
 * de projeção. Os lançamentos reais nunca são alterados: a lista recebida não é mutada.
 */
export type Decision =
  | { id: string; type: 'hire'; label: string; monthlyCost: Cents; startDate: ISODate }
  | { id: string; type: 'equipment'; label: string; amount: Cents; firstDate: ISODate; installments: number }
  | { id: string; type: 'fixed_increase'; label: string; monthlyAmount: Cents; startDate: ISODate }
  | { id: string; type: 'cost_reduction'; label: string; monthlyAmount: Cents; startDate: ISODate }
  | { id: string; type: 'sales_increase'; label: string; monthlyAmount: Cents; startDate: ISODate }
  | { id: string; type: 'renegotiate'; label: string; txId: string; newDate: ISODate }
  | { id: string; type: 'shift_receivable'; label: string; txId: string; days: number }

export type DecisionType = Decision['type']

export const DECISION_LABELS: Record<DecisionType, string> = {
  hire: 'Contratar funcionário',
  equipment: 'Comprar equipamento',
  fixed_increase: 'Aumentar despesa fixa',
  cost_reduction: 'Reduzir um custo',
  sales_increase: 'Aumento de vendas',
  renegotiate: 'Renegociar vencimento',
  shift_receivable: 'Atrasar ou antecipar recebimento',
}

export class DecisionError extends Error {}

function monthly(startDate: ISODate, endDate: ISODate, amount: Cents, direction: 'in' | 'out', description: string): ProjectedEvent[] {
  const out: ProjectedEvent[] = []
  for (let i = 0; i < 24; i++) {
    const d = addMonths(startDate, i)
    if (d > endDate) break
    out.push({ txId: null, description, direction, amount, originalDate: d, effectiveDate: d })
  }
  return out
}

export interface CompiledDecisions {
  extraEvents: ProjectedEvent[]
  dateOverrides: Map<string, { date: ISODate; reason: string }>
  assumptions: string[]
}

export function compileDecisions(decisions: Decision[], transactions: Transaction[], asOf: ISODate, horizonDays: number): CompiledDecisions {
  const endDate = addDays(asOf, horizonDays - 1)
  const extraEvents: ProjectedEvent[] = []
  const dateOverrides = new Map<string, { date: ISODate; reason: string }>()
  const assumptions: string[] = []
  const byId = new Map(transactions.map((t) => [t.id, t]))

  for (const d of decisions) {
    switch (d.type) {
      case 'hire':
      case 'fixed_increase':
        positive(d.type === 'hire' ? d.monthlyCost : d.monthlyAmount)
        extraEvents.push(...monthly(d.startDate, endDate, d.type === 'hire' ? d.monthlyCost : d.monthlyAmount, 'out', d.label))
        assumptions.push(`${d.label}: saída mensal a partir de ${d.startDate}, mesmo dia de cada mês.`)
        break
      case 'cost_reduction':
        positive(d.monthlyAmount)
        extraEvents.push(...monthly(d.startDate, endDate, d.monthlyAmount, 'in', `${d.label} (economia)`))
        assumptions.push(`${d.label}: economia mensal tratada como entrada equivalente a partir de ${d.startDate}.`)
        break
      case 'sales_increase':
        positive(d.monthlyAmount)
        extraEvents.push(...monthly(d.startDate, endDate, d.monthlyAmount, 'in', d.label))
        assumptions.push(`${d.label}: entrada adicional mensal a partir de ${d.startDate}. Valor informado pelo usuário, não previsto pelo sistema.`)
        break
      case 'equipment': {
        positive(d.amount)
        if (!Number.isInteger(d.installments) || d.installments < 1 || d.installments > 48) throw new DecisionError('Parcelas devem estar entre 1 e 48')
        const base = Math.floor(d.amount / d.installments)
        const remainder = d.amount - base * d.installments
        for (let i = 0; i < d.installments; i++) {
          const date = addMonths(d.firstDate, i)
          if (date > endDate) break
          extraEvents.push({
            txId: null,
            description: `${d.label} (${i + 1}/${d.installments})`,
            direction: 'out',
            // O centavo restante vai na primeira parcela: a soma das parcelas é exatamente o total.
            amount: base + (i === 0 ? remainder : 0),
            originalDate: date,
            effectiveDate: date,
          })
        }
        assumptions.push(`${d.label}: ${d.installments} parcela(s) mensal(is) a partir de ${d.firstDate}.`)
        break
      }
      case 'renegotiate': {
        const tx = byId.get(d.txId)
        if (!tx || tx.status !== 'pending' || tx.kind !== 'expense') throw new DecisionError('Selecione uma conta a pagar pendente')
        dateOverrides.set(tx.id, { date: d.newDate, reason: `renegociado para ${d.newDate}` })
        assumptions.push(`"${tx.description}" passa a vencer em ${d.newDate}, sem juros ou multa considerados.`)
        break
      }
      case 'shift_receivable': {
        const tx = byId.get(d.txId)
        if (!tx || tx.status !== 'pending' || tx.kind !== 'income') throw new DecisionError('Selecione uma conta a receber pendente')
        const date = addDays(tx.dueDate, d.days)
        dateOverrides.set(tx.id, {
          date,
          reason: d.days >= 0 ? `atrasado ${d.days} dia(s)` : `antecipado ${-d.days} dia(s)`,
        })
        assumptions.push(`"${tx.description}" ${d.days >= 0 ? 'atrasa' : 'antecipa'} ${Math.abs(d.days)} dia(s), sem desconto ou encargos.`)
        break
      }
    }
  }
  return { extraEvents, dateOverrides, assumptions }
}

function positive(v: Cents) {
  if (!Number.isSafeInteger(v) || v <= 0) throw new DecisionError('Informe um valor maior que zero')
}

export interface SimulationResult {
  current: Projection
  alternative: Projection
  comparison: ScenarioComparison
  assumptions: string[]
  /** Datas onde o saldo alternativo fica abaixo de zero. */
  criticalDates: ISODate[]
}

export function simulate(params: {
  accounts: Account[]
  transactions: Transaction[]
  asOf: ISODate
  horizonDays: number
  decisions: Decision[]
  scenario?: ScenarioAssumptions
}): SimulationResult {
  const scenario = params.scenario ?? BASE_SCENARIO
  const base = {
    accounts: params.accounts,
    transactions: params.transactions,
    asOf: params.asOf,
    horizonDays: params.horizonDays,
    assumptions: scenario,
  }
  const compiled = compileDecisions(params.decisions, params.transactions, params.asOf, params.horizonDays)
  const current = projectCashflow(base)
  const alternative = projectCashflow({
    ...base,
    extraEvents: compiled.extraEvents,
    dateOverrides: compiled.dateOverrides,
  })
  return {
    current,
    alternative,
    comparison: compareProjections(current, alternative),
    assumptions: compiled.assumptions,
    criticalDates: alternative.days.filter((d) => d.balance < 0).map((d) => d.date),
  }
}
