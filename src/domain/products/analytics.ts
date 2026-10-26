import type { Product, ProductSale } from '@/domain/types'
import type { Cents } from '@/lib/money'
import { addDays, diffDays, type ISODate } from '@/lib/dates'
import { QTY_SCALE, sumQuantities, type MilliQty } from './quantity'

/**
 * Análises puras de produtos. Janelas são inclusivas e relativas à data de referência.
 * Todos os valores são rastreáveis: cada resultado carrega os números que o sustentam.
 */

export interface ProductStat {
  product: Product
  quantity: MilliQty
  revenue: Cents
  salesCount: number
  lastSaleDate: ISODate | null
  unitCost: Cents | null
  margin: Cents | null
  marginPct: number | null
}

const inRange = (sale: ProductSale, from: ISODate, to: ISODate) => sale.saleDate >= from && sale.saleDate <= to

export function salesInRange(sales: ProductSale[], from: ISODate, to: ISODate): ProductSale[] {
  return sales.filter((s) => inRange(s, from, to))
}

/** Custo unitário: o cadastro manda; sem ele, usa a média ponderada das vendas que informaram custo. */
export function resolveUnitCost(product: Product, sales: ProductSale[]): Cents | null {
  if (product.costPrice !== null) return product.costPrice
  let quantity = 0
  let cost = 0
  for (const sale of sales) {
    if (sale.unitCost === null) continue
    quantity += sale.quantity
    cost += Math.round((sale.quantity * sale.unitCost) / 1000)
  }
  return quantity > 0 ? Math.round((cost * 1000) / quantity) : null
}

export function productStats(products: Product[], sales: ProductSale[], from: ISODate, to: ISODate): ProductStat[] {
  const byProduct = new Map<string, ProductSale[]>()
  for (const sale of sales) {
    if (!inRange(sale, from, to)) continue
    const list = byProduct.get(sale.productId)
    if (list) list.push(sale)
    else byProduct.set(sale.productId, [sale])
  }
  return products.map((product) => {
    const list = byProduct.get(product.id) ?? []
    const quantity = sumQuantities(list.map((s) => s.quantity))
    const revenue = list.reduce((total, s) => total + s.revenue, 0)
    const unitCost = resolveUnitCost(product, list)
    const totalCost = unitCost === null ? null : Math.round((quantity * unitCost) / 1000)
    const margin = totalCost === null ? null : revenue - totalCost
    return {
      product,
      quantity,
      revenue,
      salesCount: list.length,
      lastSaleDate: list.reduce<ISODate | null>((last, s) => (last === null || s.saleDate > last ? s.saleDate : last), null),
      unitCost,
      margin,
      marginPct: margin !== null && revenue > 0 ? (margin / revenue) * 100 : null,
    }
  })
}

/** Ranking dos mais vendidos em uma janela (padrão: receita). */
export function rankProducts(products: Product[], sales: ProductSale[], asOf: ISODate, days = 30, metric: 'revenue' | 'quantity' = 'revenue'): ProductStat[] {
  const stats = productStats(products, sales, addDays(asOf, -(days - 1)), asOf)
  return stats
    .filter((s) => s.quantity > 0)
    .sort((a, b) => (metric === 'revenue' ? b.revenue - a.revenue : b.quantity - a.quantity) || a.product.name.localeCompare(b.product.name))
}

/**
 * Menos vendidos: inclui produtos sem nenhuma venda na janela. Ordena por faturamento (quantidade
 * mistura kg e unidade); empate desfeito pela quantidade e pelo nome.
 */
export function leastSoldProducts(products: Product[], sales: ProductSale[], asOf: ISODate, days = 90): ProductStat[] {
  return productStats(products, sales, addDays(asOf, -(days - 1)), asOf).sort(
    (a, b) => a.revenue - b.revenue || a.quantity - b.quantity || a.product.name.localeCompare(b.product.name),
  )
}

export interface StaleProduct {
  product: Product
  lastSaleDate: ISODate | null
  daysWithoutSale: number | null
  recentQuantity: MilliQty
  previousQuantity: MilliQty
  dropPct: number | null
  reason: 'no_recent_sales' | 'sharp_drop'
}

export interface StaleOptions {
  /** Janela recente sem vendas. */
  recentDays?: number
  /** Janela anterior usada como base de comparação. */
  comparisonDays?: number
  /** Queda mínima (%) para considerar queda forte. */
  dropPct?: number
}

/**
 * Produtos parados: sem venda na janela recente, mas que vendiam antes; ou queda forte frente à
 * janela anterior. Produtos que nunca venderam não entram (não há base de comparação).
 */
export function staleProducts(products: Product[], sales: ProductSale[], asOf: ISODate, opts: StaleOptions = {}): StaleProduct[] {
  const recentDays = opts.recentDays ?? 21
  const comparisonDays = opts.comparisonDays ?? 21
  const dropThreshold = opts.dropPct ?? 50
  const recentStart = addDays(asOf, -(recentDays - 1))
  const previousEnd = addDays(recentStart, -1)
  const previousStart = addDays(previousEnd, -(comparisonDays - 1))

  const out: StaleProduct[] = []
  for (const product of products) {
    const own = sales.filter((s) => s.productId === product.id && s.saleDate <= asOf)
    if (!own.length) continue
    const lastSaleDate = own.reduce<ISODate>((last, s) => (s.saleDate > last ? s.saleDate : last), own[0].saleDate)
    const recentQuantity = sumQuantities(own.filter((s) => s.saleDate >= recentStart && s.saleDate <= asOf).map((s) => s.quantity))
    const previousQuantity = sumQuantities(own.filter((s) => s.saleDate >= previousStart && s.saleDate <= previousEnd).map((s) => s.quantity))
    const daysWithoutSale = diffDays(asOf, lastSaleDate)
    // Sem vendas na janela recente, considera parado mesmo que a janela anterior também esteja
    // zerada: o produto pode ter vendido há mais de 42 dias (histórico anterior a previousStart).
    const hasEarlierSales = own.some((s) => s.saleDate < recentStart)
    if (recentQuantity === 0 && (previousQuantity > 0 || hasEarlierSales)) {
      out.push({ product, lastSaleDate, daysWithoutSale, recentQuantity, previousQuantity, dropPct: 100, reason: 'no_recent_sales' })
    } else if (recentQuantity > 0 && previousQuantity > 0) {
      const drop = ((previousQuantity - recentQuantity) / previousQuantity) * 100
      if (drop >= dropThreshold) {
        out.push({ product, lastSaleDate, daysWithoutSale, recentQuantity, previousQuantity, dropPct: drop, reason: 'sharp_drop' })
      }
    }
  }
  return out.sort(
    (a, b) =>
      (a.reason === 'no_recent_sales' ? 0 : 1) - (b.reason === 'no_recent_sales' ? 0 : 1) ||
      (b.dropPct ?? 0) - (a.dropPct ?? 0) ||
      a.product.name.localeCompare(b.product.name),
  )
}

export interface StockEstimate {
  product: Product
  /** Estoque informado menos as vendas posteriores à contagem; nunca negativo. */
  estimated: MilliQty | null
  soldSinceCount: MilliQty
  /** Vendeu mais do que o estoque informado: o número está desatualizado. */
  outdated: boolean
}

/** Estimativa de estoque na data. Vendas no mesmo dia da contagem já estão no saldo informado. */
export function estimateStock(product: Product, sales: ProductSale[], asOf: ISODate): StockEstimate {
  if (product.stock === null) return { product, estimated: null, soldSinceCount: 0, outdated: false }
  const since = product.stockUpdatedAt
  const sold = sumQuantities(
    sales.filter((s) => s.productId === product.id && s.saleDate <= asOf && (since === null || s.saleDate > since)).map((s) => s.quantity),
  )
  const estimated = product.stock - sold
  return { product, estimated: Math.max(0, estimated), soldSinceCount: sold, outdated: estimated < 0 }
}

export type ReplenishmentStatus = 'ok' | 'reorder' | 'stale_stock' | 'insufficient_data'

const CONTINUOUS_UNITS = new Set(['kg', 'g', 'l', 'ml'])

/**
 * Arredonda a quantidade sugerida para cima. Unidades contáveis (un, cx, pct…) viram inteiro;
 * kg, g, l e ml ficam com no máximo 1 casa decimal.
 */
export function roundSuggestedQuantity(quantity: MilliQty, unit: string): MilliQty {
  if (quantity <= 0) return 0
  const step = CONTINUOUS_UNITS.has(unit.trim().toLowerCase()) ? QTY_SCALE / 10 : QTY_SCALE
  return Math.ceil(quantity / step) * step
}

export interface ReplenishmentSuggestion {
  product: Product
  stock: StockEstimate
  /** Média diária em milésimos (pode ser fracionária). */
  avgDaily: number
  coverageDays: number | null
  leadTimeDays: number | null
  suggestedQuantity: MilliQty | null
  needsReorder: boolean
  status: ReplenishmentStatus
}

export function replenishmentSuggestions(products: Product[], sales: ProductSale[], asOf: ISODate): ReplenishmentSuggestion[] {
  const from = addDays(asOf, -29)
  const out = products.map((product) => {
    const stock = estimateStock(product, sales, asOf)
    const recent = sumQuantities(sales.filter((s) => s.productId === product.id && s.saleDate >= from && s.saleDate <= asOf).map((s) => s.quantity))
    const avgDaily = recent / 30
    const coverageDays = stock.estimated !== null && avgDaily > 0 ? stock.estimated / avgDaily : null
    const leadTimeDays = product.leadTimeDays
    const belowMin = product.minStock !== null && stock.estimated !== null && stock.estimated < product.minStock
    const belowLead = coverageDays !== null && leadTimeDays !== null && coverageDays < leadTimeDays
    const needsReorder = !stock.outdated && stock.estimated !== null && (belowMin || belowLead)
    const targetDays = leadTimeDays !== null && leadTimeDays > 0 ? leadTimeDays : 7
    const target = Math.max(product.minStock ?? 0, Math.ceil(avgDaily * targetDays))
    const suggestedQuantity = needsReorder && stock.estimated !== null ? roundSuggestedQuantity(Math.max(0, target - stock.estimated), product.unit) : null
    const status: ReplenishmentStatus = stock.outdated ? 'stale_stock' : stock.estimated === null ? 'insufficient_data' : needsReorder ? 'reorder' : 'ok'
    return { product, stock, avgDaily, coverageDays, leadTimeDays, suggestedQuantity, needsReorder, status }
  })
  return out.sort((a, b) => {
    const rank = (s: ReplenishmentStatus) => (s === 'reorder' ? 0 : s === 'stale_stock' ? 1 : s === 'ok' ? 2 : 3)
    return rank(a.status) - rank(b.status) || (a.coverageDays ?? Infinity) - (b.coverageDays ?? Infinity) || a.product.name.localeCompare(b.product.name)
  })
}

export interface SeasonalityBucket {
  key: string
  label: string
  /** Média diária de faturamento em centavos. */
  avgDaily: number
  /** Média do período dividida pela média geral (1 = na média). */
  index: number
}

export interface Seasonality {
  sufficient: boolean
  historyDays: number
  /** Faturamento médio por dia, em centavos. */
  overallAvg: number
  firstTenAvg: number
  restAvg: number
  firstTenIndex: number | null
  byMonth: SeasonalityBucket[]
  byWeekday: SeasonalityBucket[]
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

/**
 * Sazonalidade observada nos próprios dados, em faturamento (R$) por dia — nunca em quantidade,
 * que misturaria kg e unidade. Só é exibida como padrão com histórico suficiente (padrão: 60 dias);
 * abaixo disso, `sufficient` é falso e a interface fala em dados insuficientes.
 */
export function analyzeSeasonality(sales: ProductSale[], asOf: ISODate, minDays = 60): Seasonality {
  const relevant = sales.filter((s) => s.saleDate <= asOf)
  if (!relevant.length) {
    return { sufficient: false, historyDays: 0, overallAvg: 0, firstTenAvg: 0, restAvg: 0, firstTenIndex: null, byMonth: [], byWeekday: [] }
  }
  const first = relevant.reduce<ISODate>((min, s) => (s.saleDate < min ? s.saleDate : min), relevant[0].saleDate)
  const historyDays = diffDays(asOf, first) + 1
  const byDay = new Map<ISODate, Cents>()
  for (const sale of relevant) byDay.set(sale.saleDate, (byDay.get(sale.saleDate) ?? 0) + sale.revenue)

  let total = 0
  let firstTenTotal = 0
  let firstTenDays = 0
  let restTotal = 0
  let restDays = 0
  const month = new Map<number, { total: number; days: number }>()
  const weekday = new Map<number, { total: number; days: number }>()

  for (let i = 0; i < historyDays; i++) {
    const date = addDays(first, i)
    const revenue = byDay.get(date) ?? 0
    const day = Number(date.slice(8, 10))
    const m = Number(date.slice(5, 7)) - 1
    const w = new Date(`${date}T00:00:00Z`).getUTCDay()
    total += revenue
    if (day <= 10) {
      firstTenTotal += revenue
      firstTenDays++
    } else {
      restTotal += revenue
      restDays++
    }
    const mb = month.get(m) ?? { total: 0, days: 0 }
    mb.total += revenue
    mb.days++
    month.set(m, mb)
    const wb = weekday.get(w) ?? { total: 0, days: 0 }
    wb.total += revenue
    wb.days++
    weekday.set(w, wb)
  }

  const overallAvg = historyDays > 0 ? total / historyDays : 0
  const firstTenAvg = firstTenDays > 0 ? firstTenTotal / firstTenDays : 0
  const restAvg = restDays > 0 ? restTotal / restDays : 0
  const bucket = (key: string, label: string, sum: number, days: number): SeasonalityBucket => {
    const avg = days > 0 ? sum / days : 0
    return { key, label, avgDaily: avg, index: overallAvg > 0 ? avg / overallAvg : 0 }
  }
  return {
    sufficient: historyDays >= minDays,
    historyDays,
    overallAvg,
    firstTenAvg,
    restAvg,
    firstTenIndex: overallAvg > 0 ? firstTenAvg / overallAvg : null,
    byMonth: [...month.entries()].sort(([a], [b]) => a - b).map(([m, v]) => bucket(String(m + 1).padStart(2, '0'), MONTHS[m], v.total, v.days)),
    byWeekday: [...weekday.entries()].sort(([a], [b]) => a - b).map(([w, v]) => bucket(String(w), WEEKDAYS[w], v.total, v.days)),
  }
}
