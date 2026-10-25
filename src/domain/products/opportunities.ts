import type { Product, ProductSale } from '@/domain/types'
import { formatBRL } from '@/lib/money'
import type { ISODate } from '@/lib/dates'
import {
  analyzeSeasonality,
  rankProducts,
  replenishmentSuggestions,
  staleProducts,
  type ReplenishmentSuggestion,
  type Seasonality,
  type StaleProduct,
} from './analytics'
import { formatQuantity } from './quantity'

export type OpportunityKind = 'stale' | 'drop' | 'restock' | 'seasonality' | 'month_start'

export interface Opportunity {
  id: string
  kind: OpportunityKind
  productId: string | null
  title: string
  /** Texto em linguagem simples, sempre com os números que sustentam a sugestão. */
  description: string
  evidence: { label: string; value: string }[]
}

export interface OpportunityInput {
  products: Product[]
  sales: ProductSale[]
  asOf: ISODate
  seasonality?: Seasonality
}

const percent = (value: number) => `${Math.round(value)}%`
const qty = (product: Product, value: number) => formatQuantity(value, product.unit)

function staleOpportunity(stale: StaleProduct): Opportunity {
  const { product } = stale
  if (stale.reason === 'no_recent_sales') {
    return {
      id: `stale:${product.id}`,
      kind: 'stale',
      productId: product.id,
      title: `${product.name} está parado`,
      description: `${product.name}: 0 vendas nos últimos 21 dias; antes vendia ${qty(product, stale.previousQuantity)} em 21 dias. Pode valer revisar a compra ou o lugar no expositor.`,
      evidence: [
        { label: 'Última venda', value: stale.lastSaleDate ? `${stale.daysWithoutSale} dias atrás` : 'sem registro' },
        { label: 'Vendas nos 21 dias anteriores', value: qty(product, stale.previousQuantity) },
        { label: 'Vendas nos últimos 21 dias', value: qty(product, 0) },
      ],
    }
  }
  return {
    id: `drop:${product.id}`,
    kind: 'drop',
    productId: product.id,
    title: `${product.name} caiu ${percent(Math.abs(stale.dropPct ?? 0))}`,
    description: `${product.name}: as vendas caíram de ${qty(product, stale.previousQuantity)} para ${qty(product, stale.recentQuantity)} em 21 dias (${percent(Math.abs(stale.dropPct ?? 0))} de queda). Considere reduzir a próxima compra ou testar uma promoção.`,
    evidence: [
      { label: '21 dias anteriores', value: qty(product, stale.previousQuantity) },
      { label: 'Últimos 21 dias', value: qty(product, stale.recentQuantity) },
      { label: 'Queda', value: percent(Math.abs(stale.dropPct ?? 0)) },
    ],
  }
}

function restockOpportunity(suggestion: ReplenishmentSuggestion, revenue: number): Opportunity {
  const { product, stock } = suggestion
  const coverage = suggestion.coverageDays !== null ? `${suggestion.coverageDays.toFixed(1).replace('.', ',')} dias` : 'sem média de vendas'
  const lead = suggestion.leadTimeDays !== null ? `${suggestion.leadTimeDays} dias` : 'não informado'
  const suggested = suggestion.suggestedQuantity !== null ? qty(product, suggestion.suggestedQuantity) : 'a definir'
  return {
    id: `restock:${product.id}`,
    kind: 'restock',
    productId: product.id,
    title: `Repor ${product.name}`,
    description: `${product.name}: ${formatBRL(revenue)} vendidos em 30 dias. O estoque estimado é ${stock.estimated !== null ? qty(product, stock.estimated) : 'desconhecido'} e cobre ${coverage}; o prazo do fornecedor é ${lead}. Pode valer pedir cerca de ${suggested}.`,
    evidence: [
      { label: 'Receita em 30 dias', value: formatBRL(revenue) },
      { label: 'Estoque estimado', value: stock.estimated !== null ? qty(product, stock.estimated) : 'não informado' },
      { label: 'Cobertura estimada', value: coverage },
      { label: 'Prazo do fornecedor', value: lead },
    ],
  }
}

function seasonOpportunity(season: Seasonality, product: Product | null, month: 'june' | 'start'): Opportunity | null {
  if (!season.sufficient || season.overallAvg <= 0) return null
  if (month === 'start') {
    if (season.firstTenIndex === null || season.firstTenIndex < 1.1) return null
    // O percentual compara exatamente os dois números exibidos (dias 1 a 10 × demais dias).
    if (season.restAvg <= 0) return null
    const diff = (season.firstTenAvg / season.restAvg - 1) * 100
    return {
      id: 'season:month-start',
      kind: 'month_start',
      productId: product?.id ?? null,
      title: 'Início do mês vende mais',
      description: `Nos dias 1 a 10, o faturamento por dia fica ${percent(diff)} acima dos demais dias (${formatBRL(season.firstTenAvg)} por dia contra ${formatBRL(season.restAvg)} no resto do mês). Considere antecipar as compras do início do mês.`,
      evidence: [
        { label: 'Dias 1 a 10 (faturamento/dia)', value: formatBRL(season.firstTenAvg) },
        { label: 'Demais dias (faturamento/dia)', value: formatBRL(season.restAvg) },
        { label: 'Histórico', value: `${season.historyDays} dias` },
      ],
    }
  }
  const june = season.byMonth.find((b) => b.key === '06')
  if (!june || june.index < 1.1) return null
  return {
    id: 'season:june',
    kind: 'seasonality',
    productId: product?.id ?? null,
    title: 'Junho costuma vender mais',
    description: `Em junho, o faturamento fica ${percent((june.index - 1) * 100)} acima da média (${formatBRL(june.avgDaily)} por dia). Pode valer preparar estoque antes do São João.`,
    evidence: [
      { label: 'Junho (faturamento/dia)', value: formatBRL(june.avgDaily) },
      { label: 'Média geral (faturamento/dia)', value: formatBRL(season.overallAvg) },
      { label: 'Histórico', value: `${season.historyDays} dias` },
    ],
  }
}

/**
 * Oportunidades acionáveis com evidência numérica. O texto sugere ("pode valer", "considere") e
 * nunca afirma certeza sobre o futuro. Sazonalidade exige histórico suficiente.
 */
export function generateOpportunities(input: OpportunityInput): Opportunity[] {
  const { products, sales, asOf } = input
  const season = input.seasonality ?? analyzeSeasonality(sales, asOf)
  const stale = staleProducts(products, sales, asOf)
  const recent30 = rankProducts(products, sales, asOf, 30, 'revenue')
  const suggestions = replenishmentSuggestions(products, sales, asOf)
  const revenueByProduct = new Map(recent30.map((s) => [s.product.id, s.revenue]))

  const opportunities: Opportunity[] = []
  for (const item of stale.slice(0, 3)) opportunities.push(staleOpportunity(item))
  for (const suggestion of suggestions.filter((s) => s.needsReorder).slice(0, 2)) {
    opportunities.push(restockOpportunity(suggestion, revenueByProduct.get(suggestion.product.id) ?? 0))
  }
  const topProduct = recent30[0]?.product ?? null
  const startSeason = seasonOpportunity(season, topProduct, 'start')
  if (startSeason) opportunities.push(startSeason)
  const juneSeason = seasonOpportunity(season, topProduct, 'june')
  if (juneSeason) opportunities.push(juneSeason)
  return opportunities.slice(0, 6)
}
