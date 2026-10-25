import type { Product, ProductSale } from '@/domain/types'
import { norm, type RawTable } from '@/domain/import/pipeline'
import type { Cell } from '@/domain/import/xlsx'
import { formatBRL, parseMoney, type Cents } from '@/lib/money'
import { parseDateFlexible, type ISODate } from '@/lib/dates'
import { parseQuantity, revenueFor, type MilliQty } from './quantity'

/** Mapeamento de planilhas de PDV/maquininha para vendas por item. */

export type ProductImportField = 'date' | 'product' | 'code' | 'quantity' | 'total' | 'unitPrice' | 'unitCost' | 'stock' | 'status' | 'externalId'

export const PRODUCT_FIELD_LABELS: Record<ProductImportField, string> = {
  date: 'Data da venda',
  product: 'Produto',
  code: 'Código',
  quantity: 'Quantidade',
  total: 'Valor total',
  unitPrice: 'Valor unitário',
  unitCost: 'Custo unitário',
  stock: 'Estoque atual',
  status: 'Situação',
  externalId: 'Identificador de origem',
}

const PRODUCT_SYNONYMS: Record<ProductImportField, string[]> = {
  date: ['data', 'data venda', 'data da venda', 'data movimento', 'emissao', 'dt', 'date', 'dia'],
  product: ['produto', 'item', 'descricao', 'descricao produto', 'nome produto', 'mercadoria', 'product'],
  code: ['codigo', 'cod', 'sku', 'codigo produto', 'cod produto', 'ean', 'gtin', 'referencia'],
  quantity: ['quantidade', 'qtd', 'qtde', 'quant', 'unidades', 'peso', 'volume', 'qty'],
  total: ['valor total', 'total', 'valor', 'receita', 'montante', 'total venda', 'valor da venda'],
  unitPrice: ['valor unitario', 'preco unitario', 'preco', 'unitario', 'vlr unitario', 'preco venda'],
  unitCost: ['custo unitario', 'custo', 'custo produto', 'preco custo', 'cmv'],
  stock: ['estoque', 'estoque atual', 'saldo estoque', 'quantidade em estoque', 'saldo'],
  status: ['situacao', 'status', 'estado', 'cancelado', 'devolucao'],
  externalId: ['id', 'codigo venda', 'numero venda', 'documento', 'cupom', 'nota', 'identificador', 'venda'],
}

export type ProductColumnMapping = Partial<Record<ProductImportField, number>>

/** Sugere o mapeamento por sinônimos; cada coluna alimenta no máximo um campo. */
export function suggestProductMapping(headers: string[]): ProductColumnMapping {
  const mapping: ProductColumnMapping = {}
  const used = new Set<number>()
  const normalized = headers.map(norm)
  const fields = Object.keys(PRODUCT_SYNONYMS) as ProductImportField[]
  for (const pass of ['exact', 'partial'] as const) {
    for (const field of fields) {
      if (mapping[field] !== undefined) continue
      const idx = normalized.findIndex(
        (h, i) =>
          !used.has(i) && PRODUCT_SYNONYMS[field].some((syn) => (pass === 'exact' ? h === syn : h.split(' ').length <= 4 && ` ${h} `.includes(` ${syn} `))),
      )
      if (idx >= 0) {
        mapping[field] = idx
        used.add(idx)
      }
    }
  }
  return mapping
}

export interface NewProductSale {
  productName: string
  productCode: string | null
  productId: string | null
  saleDate: ISODate
  quantity: MilliQty
  revenue: Cents
  unitCost: Cents | null
  /** Estoque informado na planilha; atualiza o cadastro quando presente. */
  stock: MilliQty | null
  sourceRef: string
}

export interface ProductSaleRowResult {
  index: number
  raw: Cell[]
  sale: NewProductSale | null
  errors: string[]
  warnings: string[]
  alreadyImported: boolean
  include: boolean
}

export interface ProductImportContext {
  products: Product[]
  existing: Pick<ProductSale, 'sourceRef'>[]
  asOf: ISODate
}

const cellStr = (c: unknown) => (c == null ? '' : String(c).trim())
const CANCELLED = ['cancelado', 'cancelada', 'devolucao', 'devolvido', 'devolvida', 'estorno', 'estornado', 'estornada']

export function productSourceRef(sale: {
  productCode: string | null
  productName: string
  saleDate: ISODate
  quantity: MilliQty
  revenue: Cents
  externalId?: string | null
}) {
  const key = sale.productCode ? `code:${norm(sale.productCode)}` : `name:${norm(sale.productName)}`
  const externalKey = sale.externalId ? norm(sale.externalId) : ''
  const external = externalKey ? `|ext:${externalKey}` : ''
  return `sale:${key}${external}|${sale.saleDate}|${sale.quantity}|${sale.revenue}`
}

/** Nome normalizado, sem acentos/espaços duplicados, para casar produtos entre planilhas. */
export const productKey = (name: string) => norm(name)

export function validateProductSaleRows(table: RawTable, mapping: ProductColumnMapping, ctx: ProductImportContext): ProductSaleRowResult[] {
  const byCode = new Map<string, Product>()
  const byName = new Map<string, Product>()
  for (const p of ctx.products) {
    if (p.code) byCode.set(norm(p.code), p)
    byName.set(productKey(p.name), p)
  }
  const existingRefs = new Set(ctx.existing.map((s) => s.sourceRef).filter((r): r is string => !!r))
  const seenInFile = new Map<string, { line: number; count: number }>()

  return table.rows.map((raw, i) => {
    const errors: string[] = []
    const warnings: string[] = []
    const get = (f: ProductImportField) => (mapping[f] === undefined ? undefined : raw[mapping[f]!])

    const dateRaw = get('date')
    const saleDate = dateRaw == null || cellStr(dateRaw) === '' ? null : parseDateFlexible(dateRaw)
    if (mapping.date === undefined) errors.push('Coluna de data não mapeada')
    else if (!saleDate) errors.push(`Data inválida: "${cellStr(dateRaw)}"`)
    else if (saleDate > ctx.asOf) errors.push('Data da venda no futuro')

    const productName = cellStr(get('product'))
    const productCode = cellStr(get('code')) || null
    if (!productName) errors.push('Produto vazio')
    else if (productName.length < 2) errors.push('Nome do produto deve ter ao menos 2 caracteres')
    if (productName.length > 120) errors.push('Nome do produto acima de 120 caracteres')
    if (productCode && productCode.length > 40) errors.push('Código do produto acima de 40 caracteres')

    const qtyRaw = get('quantity')
    const quantity = qtyRaw == null || cellStr(qtyRaw) === '' ? null : parseQuantity(qtyRaw)
    if (mapping.quantity === undefined) errors.push('Coluna de quantidade não mapeada')
    else if (quantity === null) errors.push(`Quantidade inválida: "${cellStr(qtyRaw)}"`)

    const totalRaw = get('total')
    const total = totalRaw == null || cellStr(totalRaw) === '' ? null : parseMoney(totalRaw)
    const unitRaw = get('unitPrice')
    const unitPrice = unitRaw == null || cellStr(unitRaw) === '' ? null : parseMoney(unitRaw)
    if (totalRaw != null && cellStr(totalRaw) !== '' && total === null) errors.push(`Valor total inválido: "${cellStr(totalRaw)}"`)
    if (unitRaw != null && cellStr(unitRaw) !== '' && unitPrice === null) errors.push(`Valor unitário inválido: "${cellStr(unitRaw)}"`)

    let revenue: Cents | null = null
    if (total !== null) {
      revenue = total
      if (unitPrice !== null && quantity !== null && quantity > 0) {
        const expected = revenueFor(quantity, unitPrice)
        if (Math.abs(expected - total) > 5) {
          warnings.push(`Total difere de quantidade × valor unitário em ${formatBRL(Math.abs(expected - total))}; usando o total`)
        }
      }
    } else if (quantity !== null && quantity <= 0) {
      // Devolução/cancelamento: a linha será desmarcada com aviso, então não exige valor total.
    } else if (unitPrice !== null && quantity !== null && quantity > 0) {
      revenue = revenueFor(quantity, unitPrice)
    } else if (mapping.total === undefined && mapping.unitPrice === undefined) {
      errors.push('Mapeie o valor total ou o valor unitário')
    } else if (unitPrice === null && (totalRaw == null || cellStr(totalRaw) === '')) {
      errors.push('Valor total vazio')
    }

    const costRaw = get('unitCost')
    const unitCost = costRaw == null || cellStr(costRaw) === '' ? null : parseMoney(costRaw)
    if (costRaw != null && cellStr(costRaw) !== '' && unitCost === null) warnings.push(`Custo unitário inválido: "${cellStr(costRaw)}"; será ignorado`)
    if (unitCost !== null && unitCost < 0) warnings.push('Custo unitário negativo; será ignorado')

    const stockRaw = get('stock')
    const stock = stockRaw == null || cellStr(stockRaw) === '' ? null : parseQuantity(stockRaw)
    if (stockRaw != null && cellStr(stockRaw) !== '' && stock === null) warnings.push(`Estoque inválido: "${cellStr(stockRaw)}"; será ignorado`)

    const statusRaw = norm(cellStr(get('status')))
    const cancelled = CANCELLED.some((s) => statusRaw.includes(s))
    const externalId = cellStr(get('externalId')) || null

    if (cancelled) warnings.push('Devolução/cancelamento ignorado')
    if (quantity !== null && quantity <= 0) warnings.push('Quantidade zero ou negativa: linha ignorada')
    if (revenue !== null && revenue <= 0) warnings.push('Valor zero ou negativo (devolução): linha ignorada')
    if (stock !== null && stock < 0) warnings.push('Estoque negativo: será ignorado')

    if (cancelled) {
      return { index: i + 2, raw, sale: null, errors: [], warnings, alreadyImported: false, include: false }
    }

    const invalidQuantity = quantity === null || quantity <= 0
    const invalidRevenue = revenue === null || revenue <= 0
    if (errors.length || !saleDate || !productName || invalidQuantity || invalidRevenue) {
      return {
        index: i + 2,
        raw,
        sale: null,
        errors: errors.length ? errors : [],
        warnings: cancelled || invalidQuantity || invalidRevenue ? warnings : [],
        alreadyImported: false,
        include: false,
      }
    }

    // Só avisa sobre produto novo depois de confirmar que a linha será importada; uma linha
    // ignorada não deve prometer criação no catálogo.
    const product = (productCode ? byCode.get(norm(productCode)) : undefined) ?? byName.get(productKey(productName))
    if (!product) warnings.push('Produto novo: será criado no catálogo')

    const sale: NewProductSale = {
      productName: productName.slice(0, 120),
      productCode,
      productId: product?.id ?? null,
      saleDate,
      quantity: quantity!,
      revenue: revenue!,
      unitCost: unitCost !== null && unitCost >= 0 ? unitCost : null,
      stock: stock !== null && stock >= 0 ? stock : null,
      sourceRef: productSourceRef({ productCode, productName, saleDate, quantity: quantity!, revenue: revenue!, externalId }),
    }
    const seen = seenInFile.get(sale.sourceRef)
    if (seen) {
      seen.count++
      warnings.push(`Igual à linha ${seen.line} deste arquivo`)
      sale.sourceRef = `${sale.sourceRef}#${seen.count}`
    } else seenInFile.set(sale.sourceRef, { line: i + 2, count: 1 })

    const alreadyImported = existingRefs.has(sale.sourceRef)
    if (alreadyImported) warnings.push('Já importada anteriormente (mesmo identificador de origem)')

    return {
      index: i + 2,
      raw,
      sale,
      errors,
      warnings,
      alreadyImported,
      include: !alreadyImported && !cancelled,
    }
  })
}

export interface ProductImportSummary {
  total: number
  valid: number
  withErrors: number
  withWarnings: number
  alreadyImported: number
  selected: number
}

export function summarizeProductSales(rows: ProductSaleRowResult[]): ProductImportSummary {
  return {
    total: rows.length,
    valid: rows.filter((r) => r.sale).length,
    withErrors: rows.filter((r) => r.errors.length).length,
    withWarnings: rows.filter((r) => r.warnings.length).length,
    alreadyImported: rows.filter((r) => r.alreadyImported).length,
    selected: rows.filter((r) => r.include && r.sale).length,
  }
}
