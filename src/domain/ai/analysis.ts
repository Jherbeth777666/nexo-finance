import type { FinancialAlert } from '@/domain/types'
import type { Projection } from '@/domain/finance/projection'
import { formatBRL, type Cents } from '@/lib/money'
import { formatDateBR } from '@/lib/dates'

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
  if (/\b(certamente|garantid[oa]|com certeza|sem dúvida)\b/i.test(texts.join(' ')))
    issues.push('Linguagem de certeza incompatível com uma estimativa')
  return { valid: issues.length === 0, issues }
}

const normalizeMoney = (s: string) => s.replace(/\s/g, '')

/**
 * Exemplo demonstrativo do agente de caixa, montado por REGRAS LOCAIS a partir da projeção.
 * Nenhuma IA é chamada. Serve para mostrar o formato e o revisor funcionando.
 */
export function buildLocalCashAnalysis(p: Projection, alerts: FinancialAlert[]): { analysis: AnalysisResult; facts: Facts } {
  const facts: Facts = {
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
