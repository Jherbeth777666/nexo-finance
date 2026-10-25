import type { CompanySnapshot } from '@/data/repository'
import type { FinancialAlert, AlertState } from './types'
import { registeredBalance } from './finance/metrics'
import { BASE_SCENARIO, projectCashflow } from './finance/projection'
import { addDays, diffDays, formatDateBR, formatMonthLabel, type ISODate } from '@/lib/dates'
import { formatBRL } from '@/lib/money'
import { KIND_LABEL, statusLabel } from './transactions'

/**
 * Relatórios como dados tabulares puros: a mesma estrutura alimenta a prévia, o CSV e o PDF (impressão).
 * Valores ficam em centavos nas colunas numéricas; a formatação acontece na saída.
 */
export type ReportKind = 'cashflow' | 'income_expense' | 'open_items' | 'categories' | 'alerts' | 'scenarios'

export const REPORT_LABELS: Record<ReportKind, string> = {
  cashflow: 'Fluxo de caixa (realizado e projetado)',
  income_expense: 'Receitas e despesas por mês',
  open_items: 'Contas a pagar e a receber',
  categories: 'Totais por categoria',
  alerts: 'Alertas financeiros',
  scenarios: 'Cenários simulados',
}

export interface Column {
  key: string
  label: string
  money?: boolean
  align?: 'right'
}

export interface Report {
  kind: ReportKind
  title: string
  period: { start: ISODate; end: ISODate } | null
  note: string
  columns: Column[]
  rows: Record<string, string | number>[]
  totals?: Record<string, number>
}

export function buildReport(
  kind: ReportKind,
  data: CompanySnapshot,
  start: ISODate,
  end: ISODate,
  today: ISODate,
  alerts: (FinancialAlert & { state: AlertState })[],
): Report {
  const txs = data.transactions.filter((t) => t.status !== 'cancelled')
  const cat = new Map(data.categories.map((c) => [c.id, c.name]))
  const period = { start, end }

  switch (kind) {
    case 'cashflow': {
      const rows: Report['rows'] = []
      // Realizado: do início até min(fim, hoje).
      const realizedEnd = end < today ? end : today
      let balance = registeredBalance(data.accounts, data.transactions, addDays(start, -1))
      const byDay = new Map<ISODate, { inflow: number; outflow: number }>()
      for (const t of txs) {
        if (t.status !== 'settled' || !t.settledDate || t.kind === 'transfer' || t.settledDate < start || t.settledDate > realizedEnd) continue
        const b = byDay.get(t.settledDate) ?? { inflow: 0, outflow: 0 }
        if (t.kind === 'income') b.inflow += t.amount
        else b.outflow += t.amount
        byDay.set(t.settledDate, b)
      }
      for (let d = start; d <= realizedEnd; d = addDays(d, 1)) {
        const { inflow, outflow } = byDay.get(d) ?? { inflow: 0, outflow: 0 }
        balance += inflow - outflow
        if (inflow || outflow) rows.push({ date: formatDateBR(d), type: 'Realizado', inflow, outflow, balance })
      }
      // Projetado (cenário-base): de hoje+1 até o fim, se o período alcança o futuro.
      if (end > today) {
        const horizon = Math.min(366, diffDays(end, today) + 1)
        const p = projectCashflow({ accounts: data.accounts, transactions: data.transactions, asOf: today, horizonDays: horizon, assumptions: BASE_SCENARIO })
        for (const day of p.days) {
          if (day.date < start || (day.date === today && start <= today)) continue
          if (day.inflow || day.outflow) rows.push({ date: formatDateBR(day.date), type: 'Projetado', inflow: day.inflow, outflow: day.outflow, balance: day.balance })
        }
      }
      return {
        kind,
        title: REPORT_LABELS[kind],
        period,
        note: 'Realizado: lançamentos liquidados. Projetado: cenário-base (pendentes no vencimento; recebimentos vencidos fora). Transferências entre contas próprias não aparecem.',
        columns: [
          { key: 'date', label: 'Data' },
          { key: 'type', label: 'Tipo' },
          { key: 'inflow', label: 'Entradas', money: true, align: 'right' },
          { key: 'outflow', label: 'Saídas', money: true, align: 'right' },
          { key: 'balance', label: 'Saldo', money: true, align: 'right' },
        ],
        rows,
        totals: { inflow: sum(rows, 'inflow'), outflow: sum(rows, 'outflow') },
      }
    }
    case 'income_expense': {
      const months = new Map<string, { income: number; expense: number }>()
      for (const t of txs) {
        if (t.kind === 'transfer' || t.competenceDate < start || t.competenceDate > end) continue
        const m = t.competenceDate.slice(0, 7)
        const b = months.get(m) ?? { income: 0, expense: 0 }
        if (t.kind === 'income') b.income += t.amount
        else b.expense += t.amount
        months.set(m, b)
      }
      const rows = [...months.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([m, b]) => ({ month: formatMonthLabel(m), income: b.income, expense: b.expense, result: b.income - b.expense }))
      return {
        kind,
        title: REPORT_LABELS[kind],
        period,
        note: 'Regime de competência, liquidados ou não. "Resultado" é o resultado operacional estimado — não é lucro contábil.',
        columns: [
          { key: 'month', label: 'Mês' },
          { key: 'income', label: 'Receitas', money: true, align: 'right' },
          { key: 'expense', label: 'Despesas', money: true, align: 'right' },
          { key: 'result', label: 'Resultado', money: true, align: 'right' },
        ],
        rows,
        totals: { income: sum(rows, 'income'), expense: sum(rows, 'expense'), result: sum(rows, 'result') },
      }
    }
    case 'open_items': {
      const rows = txs
        .filter((t) => t.status === 'pending' && t.kind !== 'transfer' && t.dueDate >= start && t.dueDate <= end)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .map((t) => ({
          due: formatDateBR(t.dueDate),
          kind: KIND_LABEL[t.kind],
          description: t.description,
          counterparty: t.counterparty ?? '',
          status: statusLabel(t, today),
          amount: t.kind === 'expense' ? -t.amount : t.amount,
        }))
      return {
        kind,
        title: REPORT_LABELS[kind],
        period,
        note: 'Lançamentos pendentes com vencimento no período. Despesas com sinal negativo.',
        columns: [
          { key: 'due', label: 'Vencimento' },
          { key: 'kind', label: 'Tipo' },
          { key: 'description', label: 'Descrição' },
          { key: 'counterparty', label: 'Cliente/Fornecedor' },
          { key: 'status', label: 'Situação' },
          { key: 'amount', label: 'Valor', money: true, align: 'right' },
        ],
        rows,
        totals: { amount: sum(rows, 'amount') },
      }
    }
    case 'categories': {
      const by = new Map<string, { kind: string; total: number; count: number }>()
      for (const t of txs) {
        if (t.kind === 'transfer' || t.competenceDate < start || t.competenceDate > end) continue
        const name = t.categoryId ? (cat.get(t.categoryId) ?? 'Categoria removida') : 'Sem categoria'
        const k = `${t.kind}|${name}`
        const b = by.get(k) ?? { kind: KIND_LABEL[t.kind], total: 0, count: 0 }
        b.total += t.amount
        b.count++
        by.set(k, b)
      }
      const rows = [...by.entries()]
        .sort((a, b) => a[1].kind.localeCompare(b[1].kind) || b[1].total - a[1].total)
        .map(([k, b]) => ({ category: k.split('|')[1], kind: b.kind, count: b.count, total: b.total }))
      return {
        kind,
        title: REPORT_LABELS[kind],
        period,
        note: 'Por data de competência, liquidados ou não.',
        columns: [
          { key: 'category', label: 'Categoria' },
          { key: 'kind', label: 'Tipo' },
          { key: 'count', label: 'Lançamentos', align: 'right' },
          { key: 'total', label: 'Total', money: true, align: 'right' },
        ],
        rows,
      }
    }
    case 'alerts': {
      const sev = { critical: 'Crítico', warning: 'Atenção', info: 'Informativo' }
      const st = { new: 'Novo', in_review: 'Em análise', resolved: 'Resolvido', ignored: 'Ignorado' }
      return {
        kind,
        title: REPORT_LABELS[kind],
        period: null,
        note: `Alertas detectados em ${formatDateBR(today)} pelas regras determinísticas.`,
        columns: [
          { key: 'severity', label: 'Severidade' },
          { key: 'state', label: 'Estado' },
          { key: 'title', label: 'Alerta' },
          { key: 'period', label: 'Período analisado' },
          { key: 'impact', label: 'Impacto estimado', money: true, align: 'right' },
        ],
        rows: alerts.map((a) => ({
          severity: sev[a.severity],
          state: st[a.state],
          title: a.title,
          period: `${formatDateBR(a.period.start)} – ${formatDateBR(a.period.end)}`,
          impact: a.impact ?? '',
        })),
      }
    }
    case 'scenarios':
      return {
        kind,
        title: REPORT_LABELS[kind],
        period: null,
        note: 'Resultados registrados na data em que cada cenário foi calculado. Simulações não alteram lançamentos.',
        columns: [
          { key: 'name', label: 'Cenário' },
          { key: 'asOf', label: 'Calculado em' },
          { key: 'decisions', label: 'Decisões' },
          { key: 'currentMin', label: 'Mínimo atual', money: true, align: 'right' },
          { key: 'alternativeMin', label: 'Mínimo alternativo', money: true, align: 'right' },
          { key: 'endDelta', label: 'Δ saldo final', money: true, align: 'right' },
        ],
        rows: data.scenarios.map((s) => ({
          name: s.name,
          asOf: formatDateBR(s.asOf),
          decisions: s.decisions.map((d) => d.label).join('; '),
          currentMin: s.resultSummary.currentMin,
          alternativeMin: s.resultSummary.alternativeMin,
          endDelta: s.resultSummary.endDelta,
        })),
      }
  }
}

function sum(rows: Report['rows'], key: string) {
  return rows.reduce((s, r) => s + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0)
}

export function reportToTable(r: Report): (string | number)[][] {
  const fmt = (c: Column, v: string | number | undefined) => (c.money && typeof v === 'number' ? (v / 100).toFixed(2).replace('.', ',') : (v ?? ''))
  const out: (string | number)[][] = [r.columns.map((c) => (c.money ? `${c.label} (R$)` : c.label))]
  for (const row of r.rows) out.push(r.columns.map((c) => fmt(c, row[c.key])))
  if (r.totals) out.push(r.columns.map((c, i) => (i === 0 ? 'Total' : c.key in r.totals! ? fmt(c, r.totals![c.key]) : '')))
  return out
}

export const formatCell = (c: Column, v: string | number | undefined) => (c.money && typeof v === 'number' ? formatBRL(v) : String(v ?? ''))
