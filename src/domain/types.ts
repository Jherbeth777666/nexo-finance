import type { Cents } from '@/lib/money'
import type { ISODate } from '@/lib/dates'
import type { MilliQty } from '@/domain/products/quantity'

/**
 * Modelo de domínio. Espelha o esquema planejado para o PostgreSQL (docs/ARQUITETURA.md).
 *
 * Regras explícitas:
 * - `amount` é sempre positivo; o sentido vem de `kind`.
 * - `income`/`expense` com `status: 'pending'` são contas a receber/pagar.
 * - `transfer` move dinheiro entre contas próprias: altera o saldo de cada conta,
 *   não altera o saldo consolidado e NUNCA entra em receitas, despesas ou resultado.
 * - Lançamentos recorrentes são materializados como lançamentos individuais com o mesmo
 *   `recurrenceId`; a projeção só considera ocorrências materializadas (premissa visível).
 */
export type TxKind = 'income' | 'expense' | 'transfer'
export type TxStatus = 'pending' | 'settled' | 'cancelled'
export type TxSource = 'manual' | 'import' | 'demo'

export interface Account {
  id: string
  name: string
  /** Saldo de abertura informado pelo usuário, origem rastreável do saldo inicial. */
  openingBalance: Cents
  openingDate: ISODate
}

export interface Category {
  id: string
  name: string
  kind: 'income' | 'expense'
  /** Despesa fixa ajuda a explicar pressão recorrente. */
  fixed?: boolean
}

export interface Transaction {
  id: string
  kind: TxKind
  status: TxStatus
  description: string
  counterparty?: string
  categoryId: string | null
  accountId: string
  /** Somente para transferências: conta de destino. */
  toAccountId?: string
  amount: Cents
  /** Data de competência (a que período o fato pertence). */
  competenceDate: ISODate
  /** Vencimento (quando deve ser pago/recebido). */
  dueDate: ISODate
  /** Liquidação efetiva. Obrigatória quando status = settled. */
  settledDate: ISODate | null
  recurrenceId?: string
  notes?: string
  source: TxSource
  importId?: string
  /** Identificador de origem (linha/arquivo) para idempotência de importações. */
  sourceRef?: string
  createdAt: string
  updatedAt: string
}

export interface Company {
  id: string
  name: string
  timezone: string
  currency: 'BRL'
  isDemo: boolean
  /** Papel do usuário atual nesta empresa (dados reais). */
  role?: MemberRole
}

export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

/** Papéis que podem ser atribuídos por convite ou alteração: o dono nunca é transferido aqui. */
export type InviteRole = Exclude<MemberRole, 'owner'>

export interface CompanyMember {
  userId: string
  name: string
  /** Disponível no modo de demonstração; no Supabase o e-mail não é exposto pela API pública. */
  email?: string
  role: MemberRole
  joinedAt: string
}

export interface CompanyInvite {
  id: string
  email: string
  role: InviteRole
  createdAt: string
  expiresAt: string
  acceptedAt: string | null
  revokedAt: string | null
  /** Token puro: existe apenas no retorno de `createInvite`; nunca é gravado no banco. */
  token?: string
}

export type AlertSeverity = 'critical' | 'warning' | 'info'
export type AlertState = 'new' | 'in_review' | 'resolved' | 'ignored'
export type AlertRule =
  | 'expense_increase'
  | 'overdue_receivables'
  | 'overdue_payables'
  | 'payment_concentration'
  | 'negative_cash_risk'
  | 'receipts_drop'
  | 'suspected_duplicates'
  | 'data_inconsistency'

export interface Evidence {
  label: string
  value: string
}

export interface FinancialAlert {
  /** Impressão digital estável: mesma regra + mesmo objeto → mesmo alerta (sem repetição a cada carga). */
  fingerprint: string
  rule: AlertRule
  severity: AlertSeverity
  title: string
  description: string
  evidence: Evidence[]
  period: { start: ISODate; end: ISODate }
  detectedOn: ISODate
  source: string
  /** Impacto financeiro estimado em centavos (quando quantificável). */
  impact: Cents | null
  impactLabel: string
  nextAction: string
  /** Lançamentos que sustentam a conclusão. */
  transactionIds: string[]
  /** Quando os dados não permitem conclusão. */
  limitation?: string
}

/**
 * Produto do catálogo do comerciante. Valores monetários em centavos e quantidades em milésimos
 * (1,250 kg = 1250), nunca floats. Custo, estoque e mínimo podem ser desconhecidos (null).
 */
export interface Product {
  id: string
  name: string
  /** Código do PDV/fornecedor; usado para casar linhas de planilhas antes do nome. */
  code?: string | null
  /** Unidade de venda exibida ao lado da quantidade: un, kg, l, etc. */
  unit: string
  costPrice: Cents | null
  stock: MilliQty | null
  /** Data em que o estoque informado foi contado; vendas posteriores são descontadas. */
  stockUpdatedAt: ISODate | null
  minStock: MilliQty | null
  leadTimeDays: number | null
  createdAt: string
  updatedAt: string
}

/** Venda de um item, importada do PDV/planilha. Receita e custo unitário em centavos. */
export interface ProductSale {
  id: string
  productId: string
  saleDate: ISODate
  quantity: MilliQty
  revenue: Cents
  /** Custo unitário no momento da venda, quando a planilha informa. */
  unitCost: Cents | null
  sourceRef?: string
  importId?: string
  createdAt: string
}

export type LocalEventKind = 'regional' | 'national' | 'local'

/** Evento do calendário local cadastrado pelo comerciante (festa, feira, pagamento). */
export interface LocalEvent {
  id: string
  name: string
  startDate: ISODate
  endDate: ISODate | null
  kind: LocalEventKind
  createdAt: string
}

export interface AlertStatusRecord {
  fingerprint: string
  state: AlertState
  updatedAt: string
  note?: string
}

export interface AuditEntry {
  id: string
  at: string
  actor: string
  action: 'create' | 'update' | 'delete' | 'import' | 'reset' | 'alert_state' | 'settings'
  entity: string
  entityId: string
  summary: string
}
