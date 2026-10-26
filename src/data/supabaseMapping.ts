import type { LocalEvent, Product, ProductSale, Transaction } from '@/domain/types'
import type { ValidTransaction } from '@/domain/transactions'
import type { Cents } from '@/lib/money'
import { milliToNumeric, numericToMilli } from '@/domain/products/quantity'
import type { NewProductSale } from '@/domain/products/mapping'
import type { SaveProductInput } from './repository'

/** Conversões entre o banco (NUMERIC em reais, snake_case) e o domínio (centavos, camelCase). */

/** "1234.50" | 1234.5 → 123450. Usa aritmética de string para não depender de float. */
export function numericToCents(v: string | number | null): Cents {
  if (v === null) return 0
  const s = typeof v === 'number' ? v.toFixed(2) : v
  const m = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(s.trim())
  if (!m) throw new RangeError(`Valor numérico inválido do banco: ${s}`)
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
  return m[1] ? -cents : cents
}

/** 123450 → "1234.50" (string exata para NUMERIC(14,2)). */
export function centsToNumeric(c: Cents): string {
  if (!Number.isSafeInteger(c)) throw new RangeError(`Centavos inválidos: ${c}`)
  const sign = c < 0 ? '-' : ''
  const abs = Math.abs(c)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export interface TxRow {
  id: string
  company_id: string
  kind: Transaction['kind']
  status: Transaction['status']
  description: string
  counterparty: string | null
  category_id: string | null
  account_id: string
  to_account_id: string | null
  amount: string | number
  competence_date: string
  due_date: string
  settled_date: string | null
  recurrence_id: string | null
  notes: string | null
  source: 'manual' | 'import'
  import_id: string | null
  source_ref: string | null
  created_at: string
  updated_at: string
}

export const TX_COLUMNS =
  'id,company_id,kind,status,description,counterparty,category_id,account_id,to_account_id,amount,competence_date,due_date,settled_date,recurrence_id,notes,source,import_id,source_ref,created_at,updated_at'

export function rowToTransaction(r: TxRow): Transaction {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    description: r.description,
    counterparty: r.counterparty ?? undefined,
    categoryId: r.category_id,
    accountId: r.account_id,
    toAccountId: r.to_account_id ?? undefined,
    amount: numericToCents(r.amount),
    competenceDate: r.competence_date,
    dueDate: r.due_date,
    settledDate: r.settled_date,
    recurrenceId: r.recurrence_id ?? undefined,
    notes: r.notes ?? undefined,
    source: r.source,
    importId: r.import_id ?? undefined,
    sourceRef: r.source_ref ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Campos editáveis pelo cliente. company_id, autoria e origem são definidos pelo servidor. */
export function transactionToRow(v: ValidTransaction) {
  return {
    kind: v.kind,
    status: v.status,
    description: v.description,
    counterparty: v.counterparty ?? null,
    category_id: v.categoryId,
    account_id: v.accountId,
    to_account_id: v.toAccountId ?? null,
    amount: centsToNumeric(v.amount),
    competence_date: v.competenceDate,
    due_date: v.dueDate,
    settled_date: v.settledDate,
    recurrence_id: v.recurrenceId ?? null,
    notes: v.notes ?? null,
  }
}

/** Traduz erros do PostgREST/Postgres em mensagens úteis, sem expor detalhes internos. */
export function friendlyDbError(e: { code?: string; message?: string } | null | undefined): string {
  if (!e) return 'Erro desconhecido.'
  switch (e.code) {
    case '42501':
      return 'Você não tem permissão para esta ação nesta empresa.'
    case '23505':
      return 'Registro duplicado: já existe um registro com estes dados.'
    case '23503':
      return 'Conta ou categoria inválida para esta empresa.'
    case '23514':
    case '22023':
    case '54000':
      // Mensagens escritas por nós nas funções e gatilhos do banco.
      return e.message && e.message.length < 200 && !/constraint|violates/i.test(e.message) ? e.message : 'Os dados não passaram na validação do servidor.'
    case 'PGRST301':
    case '401':
      return 'Sua sessão expirou. Entre novamente.'
    default:
      return 'Não foi possível concluir a operação. Tente novamente.'
  }
}

export interface ProductRow {
  id: string
  company_id: string
  name: string
  code: string | null
  unit: string
  cost_price: string | number | null
  stock: string | number | null
  stock_updated_at: string | null
  min_stock: string | number | null
  lead_time_days: number | null
  created_at: string
  updated_at: string
}

export const PRODUCT_COLUMNS = 'id,company_id,name,code,unit,cost_price,stock,stock_updated_at,min_stock,lead_time_days,created_at,updated_at'

export function rowToProduct(r: ProductRow): Product {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    unit: r.unit,
    costPrice: r.cost_price === null ? null : numericToCents(r.cost_price),
    stock: r.stock === null ? null : numericToMilli(r.stock),
    stockUpdatedAt: r.stock_updated_at,
    minStock: r.min_stock === null ? null : numericToMilli(r.min_stock),
    leadTimeDays: r.lead_time_days,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function productToRow(input: SaveProductInput) {
  return {
    name: input.name.trim(),
    code: input.code?.trim() || null,
    unit: (input.unit ?? 'un').trim() || 'un',
    cost_price: input.costPrice === null ? null : centsToNumeric(input.costPrice),
    stock: input.stock === null ? null : milliToNumeric(input.stock),
    stock_updated_at: input.stock === null ? null : (input.stockUpdatedAt ?? null),
    min_stock: input.minStock === null ? null : milliToNumeric(input.minStock),
    lead_time_days: input.leadTimeDays,
  }
}

export interface ProductSaleRow {
  id: string
  company_id: string
  product_id: string
  sale_date: string
  quantity: string | number
  revenue: string | number
  unit_cost: string | number | null
  source_ref: string | null
  import_id: string | null
  created_at: string
}

export const PRODUCT_SALE_COLUMNS = 'id,company_id,product_id,sale_date,quantity,revenue,unit_cost,source_ref,import_id,created_at'

export function rowToProductSale(r: ProductSaleRow): ProductSale {
  return {
    id: r.id,
    productId: r.product_id,
    saleDate: r.sale_date,
    quantity: numericToMilli(r.quantity),
    revenue: numericToCents(r.revenue),
    unitCost: r.unit_cost === null ? null : numericToCents(r.unit_cost),
    sourceRef: r.source_ref ?? undefined,
    importId: r.import_id ?? undefined,
    createdAt: r.created_at,
  }
}

/** Linhas enviadas à RPC de importação; o servidor resolve/cria o produto. */
export function productSaleToRpcRow(s: NewProductSale) {
  return {
    product_name: s.productName,
    product_code: s.productCode,
    product_id: s.productId,
    sale_date: s.saleDate,
    quantity: milliToNumeric(s.quantity),
    revenue: centsToNumeric(s.revenue),
    unit_cost: s.unitCost === null ? null : centsToNumeric(s.unitCost),
    stock: s.stock === null ? null : milliToNumeric(s.stock),
    source_ref: s.sourceRef,
  }
}

export interface LocalEventRow {
  id: string
  company_id: string
  name: string
  start_date: string
  end_date: string | null
  kind: LocalEvent['kind']
  created_at: string
}

export const LOCAL_EVENT_COLUMNS = 'id,company_id,name,start_date,end_date,kind,created_at'

export function rowToLocalEvent(r: LocalEventRow): LocalEvent {
  return {
    id: r.id,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    kind: r.kind,
    createdAt: r.created_at,
  }
}
