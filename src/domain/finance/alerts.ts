import type { Account, AlertSeverity, Category, FinancialAlert, Transaction } from '@/domain/types'
import { formatBRL, percentChange, type Cents } from '@/lib/money'
import { addDays, formatDateBR, type ISODate } from '@/lib/dates'
import { isActive, payables, receivables } from './metrics'
import { BASE_SCENARIO, CONSERVATIVE_SCENARIO, projectCashflow } from './projection'

/**
 * Regras determinísticas de alerta. Nenhuma regra usa IA ou probabilidade inventada.
 * Cada alerta carrega evidências numéricas e os ids dos lançamentos que o sustentam.
 */
export interface AlertConfig {
  /** Aumento mínimo (%) de uma categoria de despesa em relação à média das janelas anteriores. */
  expenseIncreasePct: number
  /** Aumento mínimo em valor, para não alertar variações irrelevantes. */
  expenseIncreaseMin: Cents
  /** Queda mínima (%) de recebimentos em relação à média anterior. */
  receiptsDropPct: number
  /** Participação mínima (%) de uma semana no total de pagamentos dos próximos 30 dias. */
  concentrationSharePct: number
  concentrationMin: Cents
  /** Margem de segurança de caixa: abaixo disso, alerta informativo. */
  safetyMargin: Cents
  duplicateWindowDays: number
  /** Pendências vencidas há mais que isso provavelmente foram liquidadas sem registro. */
  staleDueDays: number
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  expenseIncreasePct: 25,
  expenseIncreaseMin: 50_000,
  receiptsDropPct: 20,
  concentrationSharePct: 40,
  concentrationMin: 300_000,
  safetyMargin: 500_000,
  duplicateWindowDays: 3,
  staleDueDays: 120,
}

/** Janela de comparação: 30 dias atuais vs. média de até 3 janelas de 30 dias anteriores. */
const WINDOW = 30
const PRIOR_WINDOWS = 3
const MIN_PRIOR_WINDOWS = 2

export interface AlertRun {
  alerts: FinancialAlert[]
  /** Análises que não puderam ser feitas, com o motivo. */
  skipped: { rule: string; reason: string }[]
}

interface Ctx {
  accounts: Account[]
  txs: Transaction[]
  categories: Category[]
  asOf: ISODate
  config: AlertConfig
}

/** Impressão digital curta e estável de um conjunto de ids (FNV-1a 32 bits, independente da ordem). */
export function idsHash(ids: string[]): string {
  let h = 0x811c9dc5
  for (const ch of [...ids].sort().join(',')) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193)
  }
  return `${ids.length}-${(h >>> 0).toString(36)}`
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }

export function detectAlerts(
  accounts: Account[],
  transactions: Transaction[],
  categories: Category[],
  asOf: ISODate,
  config: AlertConfig = DEFAULT_ALERT_CONFIG,
): AlertRun {
  const ctx: Ctx = { accounts, txs: transactions.filter(isActive), categories, asOf, config }
  const alerts: FinancialAlert[] = []
  const skipped: AlertRun['skipped'] = []

  const history = historyCoverage(ctx)
  if (history.priorWindows < MIN_PRIOR_WINDOWS) {
    const reason = `Dados insuficientes para comparação: são necessários ao menos ${MIN_PRIOR_WINDOWS * WINDOW + WINDOW} dias de histórico (há ${history.days}).`
    skipped.push({ rule: 'Aumento de despesas por categoria', reason })
    skipped.push({ rule: 'Queda de recebimentos', reason })
  } else {
    alerts.push(...expenseIncrease(ctx, history.priorWindows))
    const drop = receiptsDrop(ctx, history.priorWindows)
    if (drop) alerts.push(drop)
  }

  alerts.push(...overdue(ctx))
  const conc = concentration(ctx)
  if (conc) alerts.push(conc)
  const cash = cashRisk(ctx)
  if (cash) alerts.push(cash)
  const dup = duplicates(ctx)
  if (dup) alerts.push(dup)
  const inc = inconsistencies(ctx, transactions)
  if (inc) alerts.push(inc)

  alerts.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || Math.abs(b.impact ?? 0) - Math.abs(a.impact ?? 0),
  )
  return { alerts, skipped }
}

function historyCoverage(ctx: Ctx) {
  let earliest: ISODate | null = null
  for (const tx of ctx.txs) {
    const d = tx.settledDate && tx.settledDate < tx.competenceDate ? tx.settledDate : tx.competenceDate
    if (d <= ctx.asOf && (!earliest || d < earliest)) earliest = d
  }
  if (!earliest) return { days: 0, priorWindows: 0 }
  const days = Math.round((Date.parse(ctx.asOf) - Date.parse(earliest)) / 86_400_000) + 1
  return { days, priorWindows: Math.min(PRIOR_WINDOWS, Math.max(0, Math.floor((days - WINDOW) / WINDOW))) }
}

function windowRange(asOf: ISODate, index: number) {
  // index 0 = janela atual; 1..n = anteriores
  const end = addDays(asOf, -index * WINDOW)
  return { start: addDays(end, -(WINDOW - 1)), end }
}

function expenseIncrease(ctx: Ctx, priorWindows: number): FinancialAlert[] {
  const cur = windowRange(ctx.asOf, 0)
  const sums = new Map<string, { current: Cents; prior: Cents[]; ids: string[] }>()
  for (const tx of ctx.txs) {
    if (tx.kind !== 'expense' || !tx.categoryId) continue
    let idx = -1
    for (let i = 0; i <= priorWindows; i++) {
      const w = windowRange(ctx.asOf, i)
      if (tx.competenceDate >= w.start && tx.competenceDate <= w.end) {
        idx = i
        break
      }
    }
    if (idx < 0) continue
    let s = sums.get(tx.categoryId)
    if (!s) {
      s = { current: 0, prior: new Array(priorWindows).fill(0), ids: [] }
      sums.set(tx.categoryId, s)
    }
    if (idx === 0) {
      s.current += tx.amount
      s.ids.push(tx.id)
    } else s.prior[idx - 1] += tx.amount
  }
  const out: FinancialAlert[] = []
  const byId = new Map(ctx.txs.map((t) => [t.id, t]))
  const priorStart = windowRange(ctx.asOf, priorWindows).start
  for (const [catId, s] of sums) {
    const avg = Math.round(s.prior.reduce((a, b) => a + b, 0) / priorWindows)
    const delta = s.current - avg
    const pct = percentChange(s.current, avg)
    if (avg === 0 || pct === null) continue // sem base de comparação para a categoria
    if (pct < ctx.config.expenseIncreasePct || delta < ctx.config.expenseIncreaseMin) continue
    const cat = ctx.categories.find((c) => c.id === catId)
    const top = s.ids
      .map((id) => byId.get(id)!)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3)
    out.push({
      fingerprint: `expense_increase:${catId}:${cur.end.slice(0, 7)}`,
      rule: 'expense_increase',
      severity: pct >= ctx.config.expenseIncreasePct * 2 ? 'warning' : 'info',
      title: `Despesas com ${cat?.name ?? 'categoria'} subiram ${Math.round(pct)}%`,
      description: `Nos últimos ${WINDOW} dias, ${cat?.name ?? 'a categoria'} somou ${formatBRL(s.current)}, contra média de ${formatBRL(avg)} nas ${priorWindows} janelas anteriores de ${WINDOW} dias. Os lançamentos de maior valor estão listados abaixo; o sistema não afirma a causa.`,
      evidence: [
        { label: `Últimos ${WINDOW} dias`, value: formatBRL(s.current) },
        { label: `Média anterior (${priorWindows}×${WINDOW} dias)`, value: formatBRL(avg) },
        { label: 'Diferença', value: `${formatBRL(delta)} (+${Math.round(pct)}%)` },
        ...top.map((t) => ({ label: `${formatDateBR(t.competenceDate)} · ${t.description}`, value: formatBRL(t.amount) })),
      ],
      period: { start: priorStart, end: cur.end },
      detectedOn: ctx.asOf,
      source: 'Lançamentos de despesa por data de competência',
      impact: -delta,
      impactLabel: 'acima da média em 30 dias',
      nextAction: 'Abra os lançamentos da categoria e verifique se o aumento é pontual (ex.: reajuste, compra extra) ou recorrente.',
      transactionIds: s.ids,
    })
  }
  return out
}

function receiptsDrop(ctx: Ctx, priorWindows: number): FinancialAlert | null {
  const sums = new Array(priorWindows + 1).fill(0)
  const curIds: string[] = []
  for (const tx of ctx.txs) {
    if (tx.kind !== 'income' || tx.status !== 'settled' || !tx.settledDate) continue
    for (let i = 0; i <= priorWindows; i++) {
      const w = windowRange(ctx.asOf, i)
      if (tx.settledDate >= w.start && tx.settledDate <= w.end) {
        sums[i] += tx.amount
        if (i === 0) curIds.push(tx.id)
        break
      }
    }
  }
  const avg = Math.round(sums.slice(1).reduce((a: number, b: number) => a + b, 0) / priorWindows)
  const pct = percentChange(sums[0], avg)
  if (pct === null || pct > -ctx.config.receiptsDropPct) return null
  const cur = windowRange(ctx.asOf, 0)
  return {
    fingerprint: `receipts_drop:${cur.end.slice(0, 7)}`,
    rule: 'receipts_drop',
    severity: pct <= -ctx.config.receiptsDropPct * 2 ? 'critical' : 'warning',
    title: `Recebimentos caíram ${Math.abs(Math.round(pct))}% nos últimos ${WINDOW} dias`,
    description: `Entraram ${formatBRL(sums[0])} no período, contra média de ${formatBRL(avg)} nas janelas anteriores.`,
    evidence: [
      { label: `Últimos ${WINDOW} dias`, value: formatBRL(sums[0]) },
      { label: 'Média anterior', value: formatBRL(avg) },
    ],
    period: { start: windowRange(ctx.asOf, priorWindows).start, end: cur.end },
    detectedOn: ctx.asOf,
    source: 'Receitas liquidadas por data de recebimento',
    impact: sums[0] - avg,
    impactLabel: 'abaixo da média em 30 dias',
    nextAction: 'Verifique se há recebimentos realizados ainda não registrados ou atrasos de clientes.',
    transactionIds: curIds,
  }
}

function overdue(ctx: Ctx): FinancialAlert[] {
  const out: FinancialAlert[] = []
  const rec = receivables(ctx.txs, ctx.asOf).overdue
  const pay = payables(ctx.txs, ctx.asOf).overdue
  const byId = new Map(ctx.txs.map((t) => [t.id, t]))
  const describe = (ids: string[]) => {
    const items = ids.map((id) => byId.get(id)!).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    const oldest = items[0]
    return {
      items,
      oldest,
      evidence: [
        ...items.slice(0, 4).map((t) => ({
          label: `${t.counterparty ?? t.description} · venceu ${formatDateBR(t.dueDate)}`,
          value: formatBRL(t.amount),
        })),
        ...(items.length > 4 ? [{ label: `+${items.length - 4} outro(s)`, value: '' }] : []),
      ],
    }
  }
  if (rec.count > 0) {
    const d = describe(rec.ids)
    out.push({
      fingerprint: `overdue_receivables:${idsHash([...rec.ids])}`,
      rule: 'overdue_receivables',
      severity: rec.value >= ctx.config.safetyMargin ? 'warning' : 'info',
      title: `${rec.count} recebimento(s) vencido(s) somam ${formatBRL(rec.value)}`,
      description: `O mais antigo venceu em ${formatDateBR(d.oldest.dueDate)}. Esses valores ficam fora da projeção-base até que haja nova data prevista.`,
      evidence: d.evidence,
      period: { start: d.oldest.dueDate, end: addDays(ctx.asOf, -1) },
      detectedOn: ctx.asOf,
      source: 'Contas a receber pendentes',
      impact: rec.value,
      impactLabel: 'fora do caixa projetado',
      nextAction: 'Contate os clientes e registre uma nova data prevista ou a baixa, se já recebeu.',
      transactionIds: rec.ids,
    })
  }
  if (pay.count > 0) {
    const d = describe(pay.ids)
    out.push({
      fingerprint: `overdue_payables:${idsHash([...pay.ids])}`,
      rule: 'overdue_payables',
      severity: 'warning',
      title: `${pay.count} conta(s) a pagar vencida(s): ${formatBRL(pay.value)}`,
      description: `Vencida desde ${formatDateBR(d.oldest.dueDate)}. A projeção considera esses valores pagos hoje. Se já foram pagos, registre a liquidação.`,
      evidence: d.evidence,
      period: { start: d.oldest.dueDate, end: addDays(ctx.asOf, -1) },
      detectedOn: ctx.asOf,
      source: 'Contas a pagar pendentes',
      impact: -pay.value,
      impactLabel: 'em atraso, sujeito a encargos',
      nextAction: 'Confirme se foram pagas; caso contrário, priorize ou negocie com o fornecedor.',
      transactionIds: pay.ids,
    })
  }
  return out
}

function concentration(ctx: Ctx): FinancialAlert | null {
  const horizon = 30
  const end = addDays(ctx.asOf, horizon - 1)
  const items = ctx.txs
    .filter((t) => t.kind === 'expense' && t.status === 'pending' && t.dueDate <= end)
    .map((t) => ({ tx: t, date: t.dueDate < ctx.asOf ? ctx.asOf : t.dueDate }))
  const total = items.reduce((s, i) => s + i.tx.amount, 0)
  if (total === 0) return null
  let best = { start: ctx.asOf, sum: 0, ids: [] as string[] }
  for (let i = 0; i <= horizon - 7; i++) {
    const s = addDays(ctx.asOf, i)
    const e = addDays(s, 6)
    const inWin = items.filter((x) => x.date >= s && x.date <= e)
    const sum = inWin.reduce((a, x) => a + x.tx.amount, 0)
    if (sum > best.sum) best = { start: s, sum, ids: inWin.map((x) => x.tx.id) }
  }
  const share = (best.sum / total) * 100
  if (share < ctx.config.concentrationSharePct || best.sum < ctx.config.concentrationMin) return null
  const winEnd = addDays(best.start, 6)
  const top = best.ids
    .map((id) => ctx.txs.find((t) => t.id === id)!)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 4)
  return {
    fingerprint: `payment_concentration:${best.start}`,
    rule: 'payment_concentration',
    severity: 'warning',
    title: `${Math.round(share)}% dos pagamentos do mês vencem entre ${formatDateBR(best.start).slice(0, 5)} e ${formatDateBR(winEnd).slice(0, 5)}`,
    description: `${formatBRL(best.sum)} de ${formatBRL(total)} previstos para os próximos ${horizon} dias se concentram em 7 dias.`,
    evidence: [
      { label: 'Semana mais pesada', value: formatBRL(best.sum) },
      { label: `Total em ${horizon} dias`, value: formatBRL(total) },
      ...top.map((t) => ({ label: `${formatDateBR(t.dueDate)} · ${t.description}`, value: formatBRL(t.amount) })),
    ],
    period: { start: ctx.asOf, end },
    detectedOn: ctx.asOf,
    source: 'Contas a pagar pendentes por vencimento',
    impact: -best.sum,
    impactLabel: 'em uma única semana',
    nextAction: 'Avalie renegociar o vencimento de algum compromisso no Simulador antes de falar com o fornecedor.',
    transactionIds: best.ids,
  }
}

function cashRisk(ctx: Ctx): FinancialAlert | null {
  const params = { accounts: ctx.accounts, transactions: ctx.txs, asOf: ctx.asOf, horizonDays: 30 }
  const base = projectCashflow({ ...params, assumptions: BASE_SCENARIO })
  const cons = projectCashflow({ ...params, assumptions: CONSERVATIVE_SCENARIO })
  const period = { start: ctx.asOf, end: base.endDate }
  const ids = base.events.filter((e) => e.txId).map((e) => e.txId!) // todos os lançamentos usados
  const common = {
    rule: 'negative_cash_risk' as const,
    period,
    detectedOn: ctx.asOf,
    source: 'Motor de projeção (30 dias)',
    transactionIds: ids,
  }
  if (base.firstNegativeDate) {
    return {
      ...common,
      fingerprint: `negative_cash_risk:base:${base.firstNegativeDate.slice(0, 7)}`,
      severity: 'critical',
      title: `Caixa projetado fica negativo em ${formatDateBR(base.firstNegativeDate)}`,
      description: `No cenário-base, o saldo atinge ${formatBRL(base.minBalance)} em ${formatDateBR(base.minDate)}, com ${base.negativeDays} dia(s) abaixo de zero nos próximos 30 dias.`,
      evidence: [
        { label: 'Saldo registrado hoje', value: formatBRL(base.startBalance) },
        { label: 'Entradas previstas', value: formatBRL(base.totalIn) },
        { label: 'Saídas previstas', value: formatBRL(base.totalOut) },
        { label: `Menor saldo (${formatDateBR(base.minDate)})`, value: formatBRL(base.minBalance) },
      ],
      impact: base.minBalance,
      impactLabel: 'menor saldo projetado',
      nextAction: 'Teste no Simulador a renegociação de pagamentos próximos a essa data ou a antecipação de recebíveis.',
    }
  }
  if (cons.firstNegativeDate) {
    return {
      ...common,
      fingerprint: `negative_cash_risk:conservative:${cons.firstNegativeDate.slice(0, 7)}`,
      severity: 'warning',
      title: `Com atraso de recebimentos, o caixa fica negativo em ${formatDateBR(cons.firstNegativeDate)}`,
      description: `O cenário-base se mantém positivo (mínimo de ${formatBRL(base.minBalance)}), mas no cenário conservador (recebimentos 7 dias depois e 10% desconsiderados) o saldo chega a ${formatBRL(cons.minBalance)}.`,
      evidence: [
        { label: 'Mínimo no cenário-base', value: formatBRL(base.minBalance) },
        { label: 'Mínimo no cenário conservador', value: formatBRL(cons.minBalance) },
        { label: 'Primeiro dia negativo (conservador)', value: formatDateBR(cons.firstNegativeDate) },
      ],
      impact: cons.minBalance,
      impactLabel: 'menor saldo conservador',
      nextAction: 'Acompanhe os recebimentos dessa janela e avalie uma reserva para cobrir o intervalo.',
    }
  }
  if (base.minBalance < ctx.config.safetyMargin) {
    return {
      ...common,
      fingerprint: `negative_cash_risk:margin:${base.minDate.slice(0, 7)}`,
      severity: 'info',
      title: `Saldo projetado abaixo da margem de segurança em ${formatDateBR(base.minDate)}`,
      description: `O menor saldo previsto (${formatBRL(base.minBalance)}) fica abaixo da margem configurada de ${formatBRL(ctx.config.safetyMargin)}.`,
      evidence: [
        { label: 'Menor saldo', value: formatBRL(base.minBalance) },
        { label: 'Margem configurada', value: formatBRL(ctx.config.safetyMargin) },
      ],
      impact: base.minBalance - ctx.config.safetyMargin,
      impactLabel: 'abaixo da margem',
      nextAction: 'Revise os compromissos próximos a essa data.',
    }
  }
  return null
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Duplicatas suspeitas: mesmo tipo, mesmo valor, mesma contraparte/descrição normalizada e datas próximas.
 * São apenas suspeitas: mesmo valor e data não provam duplicidade, por isso nada é removido automaticamente.
 */
export function findSuspectedDuplicates(txs: Transaction[], windowDays: number): [Transaction, Transaction][] {
  const groups = new Map<string, Transaction[]>()
  for (const tx of txs) {
    if (tx.kind === 'transfer' || tx.status === 'cancelled') continue
    const key = `${tx.kind}|${tx.amount}|${normalize(tx.counterparty || tx.description)}`
    const g = groups.get(key)
    if (g) g.push(tx)
    else groups.set(key, [tx])
  }
  const pairs: [Transaction, Transaction][] = []
  for (const g of groups.values()) {
    if (g.length < 2) continue
    g.sort((a, b) => a.competenceDate.localeCompare(b.competenceDate))
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1]
      const b = g[i]
      if (a.recurrenceId && a.recurrenceId === b.recurrenceId) continue // recorrência legítima
      const gap = Math.abs(Date.parse(b.competenceDate) - Date.parse(a.competenceDate)) / 86_400_000
      if (gap <= windowDays) pairs.push([a, b])
    }
  }
  return pairs
}

function duplicates(ctx: Ctx): FinancialAlert | null {
  const pairs = findSuspectedDuplicates(ctx.txs, ctx.config.duplicateWindowDays)
  if (!pairs.length) return null
  const ids = [...new Set(pairs.flat().map((t) => t.id))]
  const impact = pairs.reduce((s, [, b]) => s + b.amount, 0)
  const dates = pairs.flat().map((t) => t.competenceDate).sort()
  return {
    fingerprint: `suspected_duplicates:${idsHash(ids)}`,
    rule: 'suspected_duplicates',
    severity: 'info',
    title: `${pairs.length} possível(is) lançamento(s) duplicado(s)`,
    description: `Lançamentos com mesmo valor, mesma descrição e datas com até ${ctx.config.duplicateWindowDays} dias de diferença. Pode ser legítimo (duas compras iguais) — confirme antes de excluir.`,
    evidence: pairs.slice(0, 3).map(([a, b]) => ({
      label: `${a.description} · ${formatDateBR(a.competenceDate)} e ${formatDateBR(b.competenceDate)}`,
      value: formatBRL(a.amount),
    })),
    period: { start: dates[0], end: dates[dates.length - 1] },
    detectedOn: ctx.asOf,
    source: 'Todos os lançamentos ativos',
    impact: -impact,
    impactLabel: 'se forem duplicatas',
    nextAction: 'Compare os comprovantes e exclua o lançamento repetido, se for o caso.',
    transactionIds: ids,
  }
}

function inconsistencies(ctx: Ctx, all: Transaction[]): FinancialAlert | null {
  const noCategory: string[] = []
  const settledNoDate: string[] = []
  const futureSettlement: string[] = []
  const stale: string[] = []
  const staleLimit = addDays(ctx.asOf, -ctx.config.staleDueDays)
  for (const tx of all) {
    if (tx.status === 'cancelled') continue
    if (tx.kind !== 'transfer' && !tx.categoryId) noCategory.push(tx.id)
    if (tx.status === 'settled' && !tx.settledDate) settledNoDate.push(tx.id)
    if (tx.settledDate && tx.settledDate > ctx.asOf) futureSettlement.push(tx.id)
    if (tx.status === 'pending' && tx.dueDate < staleLimit) stale.push(tx.id)
  }
  const evidence = [
    noCategory.length && { label: 'Sem categoria', value: `${noCategory.length} lançamento(s)` },
    settledNoDate.length && { label: 'Liquidado sem data de liquidação', value: `${settledNoDate.length}` },
    futureSettlement.length && { label: 'Liquidação com data futura', value: `${futureSettlement.length}` },
    stale.length && {
      label: `Pendente vencido há mais de ${ctx.config.staleDueDays} dias`,
      value: `${stale.length}`,
    },
  ].filter(Boolean) as { label: string; value: string }[]
  if (!evidence.length) return null
  const ids = [...new Set([...noCategory, ...settledNoDate, ...futureSettlement, ...stale])]
  return {
    fingerprint: `data_inconsistency:${idsHash(ids)}`,
    rule: 'data_inconsistency',
    severity: settledNoDate.length || futureSettlement.length ? 'warning' : 'info',
    title: `${ids.length} lançamento(s) com dados incompletos ou inconsistentes`,
    description: 'Dados incompletos reduzem a precisão de categorias, comparações e projeções.',
    evidence,
    period: { start: staleLimit, end: ctx.asOf },
    detectedOn: ctx.asOf,
    source: 'Validação dos lançamentos',
    impact: null,
    impactLabel: 'qualidade dos dados',
    nextAction: 'Revise os lançamentos listados e complete as informações.',
    transactionIds: ids,
  }
}
