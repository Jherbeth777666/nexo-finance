import { buildDemoDataset } from '@/data/demo/seed'
import { detectAlerts } from './alerts'
import { monthlyEvolution } from './metrics'
import { BASE_SCENARIO, projectCashflow } from './projection'

/**
 * Conjunto de desempenho documentado: a base de demonstração replicada 50× (~10 mil lançamentos),
 * equivalente a vários anos de uma pequena empresa. Limites folgados para não falhar em CI lento;
 * os tempos medidos são impressos com PERF=1.
 */
const today = '2026-10-24'
const ds = buildDemoDataset(today)
const big = Array.from({ length: 50 }, (_, k) => ds.transactions.map((t) => ({ ...t, id: `${t.id}-${k}` }))).flat()

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now()
  const r = fn()
  return [r, performance.now() - t0]
}

describe(`desempenho com ${big.length} lançamentos`, () => {
  it('projeção de 90 dias, alertas e evolução dentro do orçamento', () => {
    const [, tProj] = time(() => projectCashflow({ accounts: ds.accounts, transactions: big, asOf: today, horizonDays: 90, assumptions: BASE_SCENARIO }))
    const [, tAlerts] = time(() => detectAlerts(ds.accounts, big, ds.categories, today))
    const [, tEvo] = time(() => monthlyEvolution(ds.accounts, big, today, 6))
    if (process.env.PERF) console.log({ n: big.length, projection90_ms: tProj.toFixed(1), alerts_ms: tAlerts.toFixed(1), evolution_ms: tEvo.toFixed(1) })
    expect(tProj).toBeLessThan(500)
    expect(tAlerts).toBeLessThan(2000)
    expect(tEvo).toBeLessThan(500)
  })
})
