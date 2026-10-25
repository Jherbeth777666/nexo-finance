import { BASE_SCENARIO, projectCashflow } from '@/domain/finance/projection'
import { acc, tx } from '@/domain/finance/testkit'
import type { Facts } from './analysis'
import {
  buildCashFacts,
  buildExpenseFacts,
  buildScenarioFacts,
  canonicalFactsJson,
  computeInputHash,
  sanitizeLabel,
  type CategoryTotal,
  type ScenarioFactSummary,
} from './facts'

const projection = () =>
  projectCashflow({
    accounts: [acc({ openingBalance: 10_000 })],
    transactions: [
      tx({ kind: 'income', amount: 20_000, status: 'pending', dueDate: '2026-03-18', description: 'Recebimento sigiloso do cliente X' }),
      tx({ kind: 'expense', amount: 25_000, status: 'pending', dueDate: '2026-03-20', description: 'Pagamento confidencial Fornecedor Y' }),
    ],
    asOf: '2026-03-15',
    horizonDays: 30,
    assumptions: BASE_SCENARIO,
  })

describe('fatos de caixa', () => {
  it('monta apenas agregados, sem descrições, contrapartes ou notas', () => {
    const facts = buildCashFacts(projection())
    const raw = JSON.stringify(facts)
    expect(raw).not.toMatch(/Recebimento sigiloso|Pagamento confidencial|Fornecedor Y|cliente X/)
    expect(facts.start.value).toBe(10_000)
    expect(facts.in.value).toBe(20_000)
    expect(facts.out.value).toBe(25_000)
    expect(facts.min.value).toBe(5_000)
    expect(facts.minDate.value).toBe('20/03/2026')
    expect(facts.periodStart.value).toBe('2026-03-15')
    expect(facts.periodEnd.value).toBe('2026-04-13')
  })
})

describe('fatos de despesas', () => {
  const totals = (): CategoryTotal[] => [
    { name: 'Aluguel\ncom instrução ignorada', kind: 'expense', total: 120_000 },
    { name: 'Fornecedores', kind: 'expense', total: 80_000 },
    { name: 'Vendas', kind: 'income', total: 500_000 },
    { name: 'Zerada', kind: 'expense', total: 0 },
  ]

  it('agrega por categoria e não inclui receitas', () => {
    const facts = buildExpenseFacts(totals(), '2026-03-31', 90)
    expect(facts.expenseTotal.value).toBe(200_000)
    expect(facts.cat0.value).toBe(120_000)
    expect(facts.cat1.value).toBe(80_000)
    expect(facts.categoryCount.value).toBe('2')
    expect(Object.keys(facts)).not.toContain('cat2')
    expect(facts.periodStart.value).toBe('2026-01-01')
    expect(facts.periodEnd.value).toBe('2026-03-31')
  })

  it('sanitiza rótulos e limita o tamanho', () => {
    const facts = buildExpenseFacts(totals(), '2026-03-31')
    expect(facts.cat0.label).toBe('Aluguel com instrução ignorada')
    expect(facts.cat0.label).not.toContain('\n')
    expect(sanitizeLabel('x'.repeat(80))).toHaveLength(60)
    expect(sanitizeLabel('a\u0000 b\n c')).toBe('a b c')
    expect(sanitizeLabel('')).toBe('Sem nome')
  })
})

describe('fatos de cenários', () => {
  it('resume variações sem nomes de cenário', () => {
    const scenarios: ScenarioFactSummary[] = [
      { horizonDays: 30, asOf: '2026-03-15', resultSummary: { currentMin: 1_000, alternativeMin: 500, endDelta: -2_000, firstNegative: null } },
      { horizonDays: 60, asOf: '2026-03-15', resultSummary: { currentMin: 1_000, alternativeMin: -3_000, endDelta: 4_000, firstNegative: '2026-04-01' } },
    ]
    const facts = buildScenarioFacts(scenarios, '2026-03-15')
    expect(facts.scenarioCount.value).toBe('2')
    expect(facts.bestEndDelta.value).toBe(4_000)
    expect(facts.worstEndDelta.value).toBe(-2_000)
    expect(facts.lowestMinBalance.value).toBe(-3_000)
    expect(facts.negativeCount.value).toBe('1')
    expect(facts.maxHorizonDays.value).toBe('60')
    expect(facts.periodStart.value).toBe('2026-03-15')
    expect(facts.periodEnd.value).toBe('2026-05-13')
    expect(JSON.stringify(facts)).not.toMatch(/cenário secreto/i)
  })

  it('não zera o melhor e o pior quando todas as variações têm o mesmo sinal', () => {
    const scenarios: ScenarioFactSummary[] = [
      { horizonDays: 30, asOf: '2026-03-15', resultSummary: { currentMin: 1_000, alternativeMin: 2_500, endDelta: 1_000, firstNegative: null } },
      { horizonDays: 30, asOf: '2026-03-15', resultSummary: { currentMin: 1_000, alternativeMin: 3_000, endDelta: 2_000, firstNegative: null } },
      { horizonDays: 60, asOf: '2026-03-15', resultSummary: { currentMin: 1_000, alternativeMin: -5_000, endDelta: -3_000, firstNegative: '2026-04-10' } },
    ]
    const positive = buildScenarioFacts(scenarios.slice(0, 2), '2026-03-15')
    expect(positive.bestEndDelta.value).toBe(2_000)
    expect(positive.worstEndDelta.value).toBe(1_000)
    expect(positive.lowestMinBalance.value).toBe(2_500)

    const negative = buildScenarioFacts(scenarios.slice(2), '2026-03-15')
    expect(negative.bestEndDelta.value).toBe(-3_000)
    expect(negative.worstEndDelta.value).toBe(-3_000)
  })

  it('lida com ausência de cenários usando a data de referência e sem valores fictícios', () => {
    const facts = buildScenarioFacts([], '2026-03-15')
    expect(facts.scenarioCount.value).toBe('0')
    expect(facts.periodStart.value).toBe('2026-03-15')
    expect(facts.periodEnd.value).toBe('2026-03-15')
    expect(facts.bestEndDelta).toBeUndefined()
    expect(facts.worstEndDelta).toBeUndefined()
    expect(facts.lowestMinBalance).toBeUndefined()
    expect(facts.referenceDate.value).toBe('15/03/2026')
  })
})

describe('hash do cache', () => {
  const a: Facts = {
    beta: { label: 'Beta', value: 200 },
    alfa: { label: 'Alfa', value: 100 },
  }
  const b: Facts = {
    alfa: { label: 'Alfa', value: 100 },
    beta: { label: 'Beta', value: 200 },
  }

  it('é SHA-256 hexadecimal e determinístico independentemente da ordem das chaves', async () => {
    const h1 = await computeInputHash('cash', a, 'v1')
    const h2 = await computeInputHash('cash', b, 'v1')
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(h1).toBe(h2)
    expect(canonicalFactsJson(a)).toBe(canonicalFactsJson(b))
  })

  it('muda com a versão do prompt, o agente ou um único valor', async () => {
    const base = await computeInputHash('cash', a, 'v1')
    expect(await computeInputHash('cash', a, 'v2')).not.toBe(base)
    expect(await computeInputHash('expenses', a, 'v1')).not.toBe(base)
    expect(await computeInputHash('cash', { ...a, alfa: { label: 'Alfa', value: 101 } }, 'v1')).not.toBe(base)
  })
})
