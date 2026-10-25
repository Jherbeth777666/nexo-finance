import { isISODate } from '@/lib/dates'
import { reviewAnalysis, type AgentKind, type AnalysisResult, type Facts, type Review } from './analysis'

/**
 * Interpretação defensiva da resposta do provedor. Nunca lança por JSON malformado: devolve uma
 * análise mínima com o revisor reprovado, para que a Edge Function registre a falha e a interface
 * mostre o motivo em vez de confiar no conteúdo.
 */
const MAX_RAW = 32_000
const MAX_SUMMARY = 1_200
const MAX_CLAIM = 300
const MAX_LIST_ITEM = 300
const MAX_EVIDENCE = 12
const MAX_LIST = 8

export interface ParseResult {
  analysis: AnalysisResult
  review: Review
}

export function parseAnalysisResponse(raw: unknown, agent: AgentKind, facts: Facts): ParseResult {
  const issues: string[] = []
  let value: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text.length > MAX_RAW) {
      issues.push('Resposta do provedor maior que o limite aceito')
      value = text.slice(0, MAX_RAW)
    } else {
      value = text
    }
    try {
      value = JSON.parse(value as string) as unknown
    } catch {
      issues.push('Resposta não é JSON válido')
      value = null
    }
  }

  const object = asObject(value)
  if (!object) issues.push('Resposta não é um objeto JSON')

  const summary = pickText(object?.summary, MAX_SUMMARY)
  if (!summary) issues.push('Resumo ausente')

  const period = parsePeriod(object?.period, issues)
  const evidence = parseEvidence(object?.evidence, issues)
  const assumptions = pickList(object?.assumptions, MAX_LIST, MAX_LIST_ITEM)
  const limitations = pickList(object?.limitations, MAX_LIST, MAX_LIST_ITEM)
  const suggestedActions = pickList(object?.suggestedActions, MAX_LIST, MAX_LIST_ITEM)

  if (typeof object?.agent === 'string' && object.agent !== agent) issues.push('Agente da resposta não corresponde ao solicitado')

  const analysis: AnalysisResult = {
    agent,
    generatedBy: 'ai',
    summary,
    period,
    evidence,
    assumptions,
    limitations,
    suggestedActions,
  }
  const reviewed = reviewAnalysis(analysis, facts)
  const all = [...issues, ...reviewed.issues]
  return { analysis, review: { valid: all.length === 0, issues: all } }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function pickText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max).trim()
}

function pickList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength).trim())
    .filter(Boolean)
    .slice(0, maxItems)
}

function parseEvidence(value: unknown, issues: string[]): AnalysisResult['evidence'] {
  if (!Array.isArray(value)) {
    if (value !== undefined) issues.push('Evidências em formato inválido')
    return []
  }
  const out: AnalysisResult['evidence'] = []
  for (const item of value) {
    const entry = asObject(item)
    const claim = pickText(entry?.claim, MAX_CLAIM)
    const factKey = pickText(entry?.factKey, 80)
    if (!claim || !factKey) {
      if (!issues.includes('Evidência incompleta')) issues.push('Evidência incompleta')
      continue
    }
    if (out.length < MAX_EVIDENCE) out.push({ claim, factKey })
  }
  return out
}

function parsePeriod(value: unknown, issues: string[]): AnalysisResult['period'] {
  const object = asObject(value)
  if (!object) {
    if (value !== undefined) issues.push('Período em formato inválido')
    return { start: '', end: '' }
  }
  const start = typeof object.start === 'string' && isISODate(object.start) ? object.start : ''
  const end = typeof object.end === 'string' && isISODate(object.end) ? object.end : ''
  if (!start || !end) issues.push('Período inválido')
  else if (start > end) issues.push('Período invertido')
  return { start, end }
}
