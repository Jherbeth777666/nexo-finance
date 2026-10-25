import type { FinancialAlert } from '@/domain/types'
import type { Projection } from '@/domain/finance/projection'
import { formatBRL, type Cents } from '@/lib/money'
import { addDays, formatDateBR, type ISODate } from '@/lib/dates'
import { buildExpenseFacts, buildScenarioFacts, sanitizeLabel, type CategoryTotal, type ScenarioFactSummary } from './facts'

/**
 * Contrato de saída das análises (Fase 5). Qualquer análise — gerada por IA ou pelas regras
 * locais — precisa ter este formato e passar pelo revisor antes de ser exibida como confiável.
 *
 * Agentes lógicos previstos: caixa, despesas, cenários e revisor. Na Fase 5 eles serão funções
 * server-side que chamam um único provedor com dados AGREGADOS (nunca a base inteira).
 */
export type AgentKind = 'cash' | 'expenses' | 'scenarios'

export interface AnalysisResult {
  agent: AgentKind
  generatedBy: 'local-rules' | 'ai'
  summary: string
  period: { start: string; end: string }
  /** Cada evidência referencia um fato calculado pelo motor determinístico. */
  evidence: { claim: string; factKey: string }[]
  assumptions: string[]
  limitations: string[]
  suggestedActions: string[]
}

/** Fatos numéricos calculados pelo sistema — a única fonte que uma análise pode citar. */
export type Facts = Record<string, { label: string; value: Cents | string }>

export interface Review {
  valid: boolean
  issues: string[]
}

const MONEY_RE = /R\$\s?[\d.]+,\d{2}/g

/**
 * Revisor de análises: confere se toda evidência aponta para um fato existente, se todo valor
 * monetário citado no texto corresponde a um fato calculado e se há limitações declaradas.
 */
export function reviewAnalysis(a: AnalysisResult, facts: Facts): Review {
  const issues: string[] = []
  if (!a.summary.trim()) issues.push('Resumo vazio')
  if (!a.evidence.length) issues.push('Nenhuma evidência apresentada')
  for (const e of a.evidence) if (!facts[e.factKey]) issues.push(`Evidência sem fato correspondente: "${e.claim}"`)
  const allowed = new Set(
    Object.values(facts)
      .filter((f) => typeof f.value === 'number')
      // Compara pelo valor absoluto: o sinal pode vir do texto ("negativo em R$ 1.000,00").
      .map((f) => normalizeMoney(formatBRL(Math.abs(f.value as number)))),
  )
  const texts = [a.summary, ...a.evidence.map((e) => e.claim), ...a.suggestedActions]
  for (const t of texts) {
    for (const m of t.match(MONEY_RE) ?? []) {
      if (!allowed.has(normalizeMoney(m))) issues.push(`Valor citado não corresponde a nenhum cálculo: ${m}`)
    }
  }
  if (!a.limitations.length) issues.push('Limitações não declaradas')
  if (/\b(certamente|garantid[oa]|com certeza|sem dúvida)\b/i.test(texts.join(' '))) issues.push('Linguagem de certeza incompatível com uma estimativa')
  return { valid: issues.length === 0, issues }
}

const normalizeMoney = (s: string) => s.replace(/\s/g, '')

/**
 * Exemplo demonstrativo do agente de caixa, montado por REGRAS LOCAIS a partir da projeção.
 * Nenhuma IA é chamada. Serve para mostrar o formato e o revisor funcionando.
 */
export function buildLocalCashAnalysis(p: Projection, alerts: FinancialAlert[]): { analysis: AnalysisResult; facts: Facts } {
  const facts: Facts = {
    periodStart: { label: 'Início do horizonte projetado', value: p.asOf },
    periodEnd: { label: 'Fim do horizonte projetado', value: p.endDate },
    start: { label: 'Saldo registrado', value: p.startBalance },
    in: { label: 'Entradas previstas', value: p.totalIn },
    out: { label: 'Saídas previstas', value: p.totalOut },
    min: { label: 'Menor saldo projetado', value: p.minBalance },
    minDate: { label: 'Data do menor saldo', value: formatDateBR(p.minDate) },
    end: { label: 'Saldo ao fim do horizonte', value: p.endBalance },
    overdue: { label: 'Recebimentos vencidos fora da projeção', value: p.excluded.overdueReceivables.amount },
  }
  const top = p.pressureDays[0]
  if (top) facts.pressure = { label: `Saída líquida em ${formatDateBR(top.date)}`, value: top.outflow - top.inflow }
  const conc = alerts.find((a) => a.rule === 'payment_concentration')

  const negative = p.firstNegativeDate
  const summary = negative
    ? `Com os lançamentos atuais, o caixa fica negativo em ${formatDateBR(negative)} e chega a ${formatBRL(p.minBalance)} em ${formatDateBR(p.minDate)}.`
    : `O caixa permanece positivo nos próximos ${p.horizonDays} dias. O ponto mais baixo é ${formatBRL(p.minBalance)} em ${formatDateBR(p.minDate)}${top ? `, logo após a maior saída líquida do período (${formatBRL(top.outflow - top.inflow)} em ${formatDateBR(top.date)})` : ''}.`

  const evidence: AnalysisResult['evidence'] = [
    { claim: `Saldo registrado hoje: ${formatBRL(p.startBalance)}`, factKey: 'start' },
    { claim: `Entradas previstas no horizonte: ${formatBRL(p.totalIn)}`, factKey: 'in' },
    { claim: `Saídas previstas no horizonte: ${formatBRL(p.totalOut)}`, factKey: 'out' },
    { claim: `Menor saldo: ${formatBRL(p.minBalance)} em ${formatDateBR(p.minDate)}`, factKey: 'min' },
  ]
  if (top) evidence.push({ claim: `Maior saída líquida: ${formatBRL(top.outflow - top.inflow)} em ${formatDateBR(top.date)}`, factKey: 'pressure' })

  const limitations = [
    'Considera apenas lançamentos registrados; vendas futuras não lançadas não aparecem.',
    'Datas de recebimento podem variar; veja o cenário conservador.',
  ]
  if (p.excluded.overdueReceivables.count)
    limitations.push(`${formatBRL(p.excluded.overdueReceivables.amount)} em recebimentos vencidos não entram, pois não há nova data prevista.`)

  const actions: string[] = []
  if (conc) actions.push('Avaliar no simulador a renegociação de um dos pagamentos da semana mais carregada.')
  if (p.excluded.overdueReceivables.count) actions.push('Cobrar os recebimentos vencidos e registrar uma nova data prevista.')
  if (!actions.length) actions.push('Acompanhar a semana do menor saldo e confirmar os recebimentos previstos.')

  return {
    facts,
    analysis: {
      agent: 'cash',
      generatedBy: 'local-rules',
      summary,
      period: { start: p.asOf, end: p.endDate },
      evidence,
      assumptions: ['Cenário-base: recebimentos no vencimento; pagamentos vencidos considerados pagos hoje.'],
      limitations,
      suggestedActions: actions,
    },
  }
}

export interface LocalAnalysisInput {
  asOf?: string
  projection?: Projection
  alerts?: FinancialAlert[]
  categoryTotals?: CategoryTotal[]
  categoryDays?: number
  scenarios?: ScenarioFactSummary[]
}

export interface LocalAnalysisResult {
  analysis: AnalysisResult
  facts: Facts
  review: Review
}

/**
 * Exemplo local por agente, montado por REGRAS DETERMINÍSTICAS. Usado somente no modo de
 * demonstração: o Supabase chama a Edge Function e nunca executa regras locais no navegador.
 */
export function buildLocalAnalysis(agent: AgentKind, input: LocalAnalysisInput): LocalAnalysisResult {
  if (agent === 'cash') {
    if (!input.projection) throw new Error('A análise de caixa exige a projeção.')
    const result = buildLocalCashAnalysis(input.projection, input.alerts ?? [])
    return { ...result, review: reviewAnalysis(result.analysis, result.facts) }
  }
  if (agent === 'expenses') {
    const asOf = input.projection?.asOf ?? input.asOf
    if (!asOf) throw new Error('A análise de despesas exige a data de referência.')
    return buildLocalExpenseAnalysis(input.categoryTotals ?? [], asOf, input.categoryDays ?? 90)
  }
  const asOf = input.projection?.asOf ?? input.asOf
  if (!asOf) throw new Error('A análise de cenários exige a data de referência.')
  return buildLocalScenarioAnalysis(input.scenarios ?? [], asOf)
}

function buildLocalExpenseAnalysis(categories: CategoryTotal[], asOf: string, days: number): LocalAnalysisResult {
  const facts = buildExpenseFacts(categories, asOf, days)
  const total = facts.expenseTotal.value as Cents
  const all = categories
    .filter((c) => c.kind === 'expense' && Number.isFinite(c.total) && c.total > 0)
    .map((c) => ({ name: sanitizeLabel(c.name), total: Math.round(c.total) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'pt-BR'))
  const top = all[0]
  const start = formatDateBR(addDays(asOf, -(days - 1)))
  const summary = top
    ? `Entre ${start} e ${formatDateBR(asOf)}, as despesas somam ${formatBRL(total)}. A maior categoria é "${top.name}", com ${formatBRL(top.total)}.`
    : `Não há despesas registradas entre ${start} e ${formatDateBR(asOf)}.`

  const evidence: AnalysisResult['evidence'] = [{ claim: `Despesas no período: ${formatBRL(total)}`, factKey: 'expenseTotal' }]
  if (top) evidence.push({ claim: `Maior categoria (${top.name}): ${formatBRL(top.total)}`, factKey: 'cat0' })

  const analysis: AnalysisResult = {
    agent: 'expenses',
    generatedBy: 'local-rules',
    summary,
    period: { start: addDays(asOf, -(days - 1)), end: asOf },
    evidence,
    assumptions: ['Considera despesas registradas (pendentes ou liquidadas) pela data de competência.'],
    limitations: ['Não separa despesas fixas de variáveis nem avalia fornecedores individualmente.', 'Categorias sem movimento no período não aparecem.'],
    suggestedActions: top
      ? [`Revisar a categoria "${top.name}" e verificar se o valor está dentro do esperado.`]
      : ['Registrar as despesas do período para permitir uma análise por categoria.'],
  }
  return { facts, analysis, review: reviewAnalysis(analysis, facts) }
}

function buildLocalScenarioAnalysis(scenarios: ScenarioFactSummary[], asOf: ISODate): LocalAnalysisResult {
  const facts = buildScenarioFacts(scenarios, asOf)
  const count = Number(facts.scenarioCount.value)
  const summary =
    count === 0
      ? 'Nenhum cenário salvo ainda. Salve uma simulação para comparar alternativas com a projeção atual.'
      : `Foram considerados ${count} cenário(s) salvo(s). A melhor variação de saldo final é ${formatBRL(facts.bestEndDelta.value as Cents)} e a pior é ${formatBRL(facts.worstEndDelta.value as Cents)}; o menor saldo entre os cenários é ${formatBRL(facts.lowestMinBalance.value as Cents)}, com ${Number(facts.negativeCount.value)} cenário(s) negativo(s).`

  const evidence: AnalysisResult['evidence'] = [{ claim: `Cenários salvos considerados: ${count}`, factKey: 'scenarioCount' }]
  if (count > 0) {
    evidence.push(
      { claim: `Melhor variação de saldo final: ${formatBRL(facts.bestEndDelta.value as Cents)}`, factKey: 'bestEndDelta' },
      { claim: `Pior variação de saldo final: ${formatBRL(facts.worstEndDelta.value as Cents)}`, factKey: 'worstEndDelta' },
      { claim: `Menor saldo entre os cenários: ${formatBRL(facts.lowestMinBalance.value as Cents)}`, factKey: 'lowestMinBalance' },
    )
  }

  const limitations = ['Cenários antigos podem não refletir os lançamentos atuais.', 'A comparação é uma estimativa e não uma garantia de resultado.']
  if (count === 0) limitations.unshift('Não há cenários salvos; nada foi comparado com a projeção-base.')

  const analysis: AnalysisResult = {
    agent: 'scenarios',
    generatedBy: 'local-rules',
    summary,
    period: { start: String(facts.periodStart.value), end: String(facts.periodEnd.value) },
    evidence,
    assumptions: ['Usa o resultado registrado no momento em que cada cenário foi salvo.'],
    limitations,
    suggestedActions: count
      ? ['Revisar o cenário com menor saldo projetado e confirmar as premissas usadas.']
      : ['Salvar um cenário no simulador para comparar com a projeção-base.'],
  }
  return { analysis, facts, review: reviewAnalysis(analysis, facts) }
}
