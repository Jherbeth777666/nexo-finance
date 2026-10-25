import type { ISODate } from '@/lib/dates'
import { addDays, formatDateBR } from '@/lib/dates'
import type { Cents } from '@/lib/money'
import type { AgentKind, Facts } from './analysis'

/**
 * Fatos calculados pelo motor determinístico — a ÚNICA fonte que o provedor de IA recebe.
 * Nenhuma função deste módulo aceita descrição, contraparte, nota ou lançamento individual:
 * só agregados, datas e rótulos sanitizados (nome de categoria é cadastrado pelo usuário).
 */
export const MAX_FACT_LABEL = 60

export function sanitizeLabel(input: unknown): string {
  if (typeof input !== 'string') return 'Sem nome'
  const clean = Array.from(input, (ch) => {
    const code = ch.codePointAt(0) ?? 0
    return code < 32 || code === 127 ? ' ' : ch
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FACT_LABEL)
    .trim()
  return clean || 'Sem nome'
}

export interface CashFactsInput {
  asOf: ISODate
  horizonDays: number
  startBalance: Cents
  endBalance: Cents
  totalIn: Cents
  totalOut: Cents
  minBalance: Cents
  minDate: ISODate
  firstNegativeDate: ISODate | null
  negativeDays: number
  pressureDays: { date: ISODate; inflow: Cents; outflow: Cents }[]
  excluded: { overdueReceivables: { amount: Cents; count: number } }
}

export function buildCashFacts(input: CashFactsInput): Facts {
  const facts: Facts = {
    periodStart: { label: 'Início do horizonte projetado', value: input.asOf },
    periodEnd: { label: 'Fim do horizonte projetado', value: addDays(input.asOf, input.horizonDays - 1) },
    start: { label: 'Saldo registrado na data de referência', value: input.startBalance },
    in: { label: 'Entradas previstas no horizonte', value: input.totalIn },
    out: { label: 'Saídas previstas no horizonte', value: input.totalOut },
    min: { label: 'Menor saldo projetado', value: input.minBalance },
    minDate: { label: 'Data do menor saldo projetado', value: formatDateBR(input.minDate) },
    end: { label: 'Saldo ao fim do horizonte', value: input.endBalance },
    horizonDays: { label: 'Horizonte da projeção (dias)', value: String(input.horizonDays) },
    negativeDays: { label: 'Dias com saldo projetado negativo', value: String(input.negativeDays) },
    overdue: { label: 'Recebimentos vencidos fora da projeção', value: input.excluded.overdueReceivables.amount },
    overdueCount: { label: 'Quantidade de recebimentos vencidos fora da projeção', value: String(input.excluded.overdueReceivables.count) },
  }
  if (input.firstNegativeDate) facts.negativeDate = { label: 'Primeiro dia com saldo negativo', value: formatDateBR(input.firstNegativeDate) }
  const top = input.pressureDays[0]
  if (top) facts.pressure = { label: `Saída líquida em ${formatDateBR(top.date)}`, value: top.outflow - top.inflow }
  return facts
}

export interface CategoryTotal {
  name: string
  kind: 'income' | 'expense'
  total: Cents
}

export function buildExpenseFacts(categories: CategoryTotal[], asOf: ISODate, days = 90): Facts {
  const periodStart = addDays(asOf, -(days - 1))
  const all = categories
    .filter((c) => c.kind === 'expense' && Number.isFinite(c.total) && c.total > 0)
    .map((c) => ({ name: sanitizeLabel(c.name), total: Math.round(c.total) }))
  const total = all.reduce((sum, c) => sum + c.total, 0)
  const top = all.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'pt-BR')).slice(0, 5)

  const facts: Facts = {
    periodStart: { label: 'Início do período analisado', value: periodStart },
    periodEnd: { label: 'Fim do período analisado', value: asOf },
    expenseTotal: { label: 'Total de despesas no período', value: total },
    categoryCount: { label: 'Categorias de despesa com movimento no período', value: String(all.length) },
  }
  top.forEach((c, i) => {
    facts[`cat${i}`] = { label: sanitizeLabel(c.name), value: c.total }
  })
  return facts
}

export interface ScenarioFactSummary {
  appVersion?: string
  horizonDays: number
  asOf: ISODate
  resultSummary: { currentMin: Cents; alternativeMin: Cents; endDelta: Cents; firstNegative: string | null }
}

export function buildScenarioFacts(scenarios: ScenarioFactSummary[], asOf: ISODate): Facts {
  const clean = scenarios.slice(0, 20).filter((s) => Number.isFinite(s.resultSummary.alternativeMin) && Number.isFinite(s.resultSummary.endDelta))
  const deltas = clean.map((s) => Math.round(s.resultSummary.endDelta))
  const mins = clean.map((s) => Math.round(s.resultSummary.alternativeMin))
  const endOf = (s: ScenarioFactSummary) => addDays(s.asOf, Math.max(0, s.horizonDays - 1))
  const periodStart = clean.length ? clean.reduce((min, s) => (s.asOf < min ? s.asOf : min), clean[0].asOf) : asOf
  const periodEnd = clean.length ? clean.reduce((max, s) => (endOf(s) > max ? endOf(s) : max), endOf(clean[0])) : asOf
  const facts: Facts = {
    scenarioCount: { label: 'Cenários salvos considerados', value: String(clean.length) },
    periodStart: { label: 'Início do período analisado', value: periodStart },
    periodEnd: { label: 'Fim do período analisado', value: periodEnd },
    referenceDate: { label: 'Data de referência dos cenários', value: formatDateBR(clean[0]?.asOf ?? asOf) },
  }
  if (!deltas.length) return facts
  facts.bestEndDelta = { label: 'Melhor variação de saldo final entre os cenários', value: Math.max(...deltas) }
  facts.worstEndDelta = { label: 'Pior variação de saldo final entre os cenários', value: Math.min(...deltas) }
  facts.lowestMinBalance = { label: 'Menor saldo projetado entre os cenários', value: Math.min(...mins) }
  facts.negativeCount = { label: 'Cenários que ficam com saldo negativo', value: String(clean.filter((s) => s.resultSummary.firstNegative).length) }
  facts.maxHorizonDays = { label: 'Maior horizonte simulado (dias)', value: String(clean.reduce((max, s) => Math.max(max, s.horizonDays), 0)) }
  return facts
}

export interface AiFactsInput {
  asOf: ISODate
  cash?: CashFactsInput
  categoryTotals?: CategoryTotal[]
  categoryDays?: number
  scenarios?: ScenarioFactSummary[]
}

export function buildFactsForAgent(agent: AgentKind, input: AiFactsInput): Facts {
  if (agent === 'cash') {
    if (!input.cash) throw new Error('Fatos de caixa exigem a projeção-base.')
    return buildCashFacts(input.cash)
  }
  if (agent === 'expenses') return buildExpenseFacts(input.categoryTotals ?? [], input.asOf, input.categoryDays ?? 90)
  return buildScenarioFacts(input.scenarios ?? [], input.asOf)
}

/** Objeto com chaves em ordem canônica: o hash não pode depender da ordem de montagem. */
export function canonicalFactsObject(facts: Facts): Record<string, { label: string; value: Cents | string }> {
  const out: Record<string, { label: string; value: Cents | string }> = {}
  for (const key of Object.keys(facts).sort()) out[key] = { label: facts[key].label, value: facts[key].value }
  return out
}

export function canonicalFactsJson(facts: Facts): string {
  return JSON.stringify(canonicalFactsObject(facts))
}

/** SHA-256 hexadecimal de agente + fatos canônicos + versão do prompt. */
export async function computeInputHash(agent: AgentKind, facts: Facts, promptVersion: string): Promise<string> {
  const canonical = JSON.stringify({ agent, promptVersion, facts: canonicalFactsObject(facts) })
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Web Crypto indisponível para calcular o hash da análise.')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
