import { buildLocalCashAnalysis, reviewAnalysis, type AnalysisResult } from './analysis'
import { BASE_SCENARIO, projectCashflow } from '@/domain/finance/projection'
import { acc, tx } from '@/domain/finance/testkit'

const asOf = '2026-03-15'
const p = projectCashflow({
  accounts: [acc({ openingBalance: 10_000 })],
  transactions: [
    tx({ kind: 'income', amount: 20_000, status: 'pending', dueDate: '2026-03-18' }),
    tx({ kind: 'expense', amount: 25_000, status: 'pending', dueDate: '2026-03-20' }),
  ],
  asOf,
  horizonDays: 30,
  assumptions: BASE_SCENARIO,
})

describe('revisor de análises', () => {
  it('aprova a análise local, que só cita fatos calculados', () => {
    const { analysis, facts } = buildLocalCashAnalysis(p, [])
    expect(reviewAnalysis(analysis, facts)).toEqual({ valid: true, issues: [] })
  })

  it('reprova valores inventados', () => {
    const { analysis, facts } = buildLocalCashAnalysis(p, [])
    const bad: AnalysisResult = { ...analysis, summary: 'O caixa terá R$ 99.999,00 sobrando.' }
    const r = reviewAnalysis(bad, facts)
    expect(r.valid).toBe(false)
    expect(r.issues[0]).toMatch(/não corresponde/)
  })

  it('reprova evidência sem fato, ausência de limitações e linguagem de certeza', () => {
    const { analysis, facts } = buildLocalCashAnalysis(p, [])
    const r = reviewAnalysis(
      { ...analysis, evidence: [{ claim: 'x', factKey: 'inexistente' }], limitations: [], suggestedActions: ['Certamente vai melhorar'] },
      facts,
    )
    expect(r.issues).toHaveLength(3)
  })

  it('resposta vazia (falha do provedor) nunca é válida', () => {
    const empty: AnalysisResult = {
      agent: 'cash',
      generatedBy: 'ai',
      summary: '',
      period: { start: asOf, end: asOf },
      evidence: [],
      assumptions: [],
      limitations: [],
      suggestedActions: [],
    }
    expect(reviewAnalysis(empty, {}).valid).toBe(false)
  })
})
