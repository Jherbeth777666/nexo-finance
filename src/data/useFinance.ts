import { useMemo } from 'react'
import type { FinancialAlert, AlertState } from '@/domain/types'
import { detectAlerts } from '@/domain/finance/alerts'
import {
  accountBalances,
  delinquency,
  monthlyEvolution,
  payables,
  periodSummary,
  receivables,
} from '@/domain/finance/metrics'
import { BASE_SCENARIO, projectCashflow, type ScenarioAssumptions } from '@/domain/finance/projection'
import { addDays } from '@/lib/dates'
import { useData, useStore } from './store'

/** Indicadores da visão geral, calculados uma vez por mudança de dados. */
export function useOverview() {
  const data = useData()
  const { today } = useStore()
  return useMemo(() => {
    const { accounts, transactions } = data
    const balances = accountBalances(accounts, transactions, today)
    const monthStart = `${today.slice(0, 7)}-01`
    return {
      today,
      balances,
      balance: balances.reduce((s, b) => s + b.balance, 0),
      receivables: receivables(transactions, today),
      payables: payables(transactions, today),
      delinquency: delinquency(transactions, today),
      month: periodSummary(transactions, monthStart, today),
      prev30: periodSummary(transactions, addDays(today, -29), today),
      projection30: projectCashflow({ accounts, transactions, asOf: today, horizonDays: 30, assumptions: BASE_SCENARIO }),
      evolution: monthlyEvolution(accounts, transactions, today, 6),
    }
  }, [data, today])
}

export interface AlertWithState extends FinancialAlert {
  state: AlertState
}

export function useAlerts() {
  const data = useData()
  const { today } = useStore()
  return useMemo(() => {
    const run = detectAlerts(data.accounts, data.transactions, data.categories, today, data.alertConfig)
    const alerts: AlertWithState[] = run.alerts.map((a) => ({ ...a, state: data.alertStatus[a.fingerprint]?.state ?? 'new' }))
    const open = alerts.filter((a) => a.state === 'new' || a.state === 'in_review')
    return { alerts, open, skipped: run.skipped }
  }, [data, today])
}

export function useProjection(horizonDays: number, assumptions: ScenarioAssumptions) {
  const data = useData()
  const { today } = useStore()
  return useMemo(
    () => projectCashflow({ accounts: data.accounts, transactions: data.transactions, asOf: today, horizonDays, assumptions }),
    [data.accounts, data.transactions, today, horizonDays, assumptions],
  )
}

export function useCategoryMap() {
  const data = useData()
  return useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
}
