import { formatBRL } from '@/lib/money'
import type { Facts } from './analysis'
import { parseAnalysisResponse } from './parse'

const facts: Facts = {
  start: { label: 'Saldo registrado', value: 100_000 },
}

const valid = () => ({
  agent: 'cash',
  summary: `O saldo registrado é ${formatBRL(100_000)}.`,
  period: { start: '2026-03-15', end: '2026-04-13' },
  evidence: [{ claim: `Saldo de ${formatBRL(100_000)}`, factKey: 'start' }],
  assumptions: ['Cenário-base.'],
  limitations: ['Estimativa baseada nos lançamentos registrados.'],
  suggestedActions: ['Acompanhar o caixa.'],
})

describe('interpretação da resposta de IA', () => {
  it('aceita JSON válido e força generatedBy = ai', () => {
    const parsed = parseAnalysisResponse(JSON.stringify({ ...valid(), generatedBy: 'local-rules' }), 'cash', facts)
    expect(parsed.review).toEqual({ valid: true, issues: [] })
    expect(parsed.analysis.generatedBy).toBe('ai')
    expect(parsed.analysis.agent).toBe('cash')
  })

  it('não lança com JSON malformado e reprova a análise', () => {
    const parsed = parseAnalysisResponse('{ isso não é json', 'cash', facts)
    expect(parsed.review.valid).toBe(false)
    expect(parsed.review.issues).toEqual(expect.arrayContaining(['Resposta não é JSON válido']))
    expect(parsed.analysis.summary).toBe('')
  })

  it('reprova factKey inexistente, valor inventado e linguagem de certeza', () => {
    const php = { ...valid(), evidence: [{ claim: 'x', factKey: 'inexistente' }] }
    expect(parseAnalysisResponse(php, 'cash', facts).review.valid).toBe(false)

    const money = { ...valid(), summary: 'O caixa terá R$ 99.999,00 sobrando.' }
    expect(parseAnalysisResponse(money, 'cash', facts).review.issues.some((i) => /não corresponde/.test(i))).toBe(true)

    const certainty = { ...valid(), summary: 'Certamente o caixa vai melhorar.' }
    expect(parseAnalysisResponse(certainty, 'cash', facts).review.issues.some((i) => /certeza/.test(i))).toBe(true)
  })

  it('força o agente solicitado, mesmo quando o provedor devolve outro', () => {
    const parsed = parseAnalysisResponse(JSON.stringify({ ...valid(), agent: 'expenses' }), 'cash', facts)
    expect(parsed.analysis.agent).toBe('cash')
    expect(parsed.review.issues).toContain('Agente da resposta não corresponde ao solicitado')
  })

  it('reprova período inválido ou invertido', () => {
    const invalid = { ...valid(), period: { start: '2026-13-01', end: '2026-02-01' } }
    expect(parseAnalysisResponse(invalid, 'cash', facts).review.valid).toBe(false)
    const inverted = { ...valid(), period: { start: '2026-04-13', end: '2026-03-15' } }
    expect(parseAnalysisResponse(inverted, 'cash', facts).review.issues).toContain('Período invertido')
  })

  it('trunca textos e listas fora de limites e rejeita evidência incompleta', () => {
    const parsed = parseAnalysisResponse(
      {
        ...valid(),
        summary: 'a'.repeat(5_000),
        assumptions: Array.from({ length: 20 }, () => 'x'.repeat(1_000)),
        evidence: [...Array.from({ length: 20 }, (_, i) => ({ claim: `c${i}`, factKey: 'start' })), { claim: '', factKey: 'start' }],
      },
      'cash',
      facts,
    )
    expect(parsed.analysis.summary.length).toBe(1_200)
    expect(parsed.analysis.assumptions).toHaveLength(8)
    expect(parsed.analysis.assumptions[0].length).toBe(300)
    expect(parsed.analysis.evidence).toHaveLength(12)
    expect(parsed.review.issues).toContain('Evidência incompleta')
  })

  it('rejeita resposta maior que o limite e valores que não são objeto', () => {
    expect(parseAnalysisResponse('x'.repeat(40_000), 'cash', facts).review.issues).toContain('Resposta do provedor maior que o limite aceito')
    expect(parseAnalysisResponse(null, 'cash', facts).review.issues).toContain('Resposta não é um objeto JSON')
    expect(parseAnalysisResponse([], 'cash', facts).review.valid).toBe(false)
  })
})
