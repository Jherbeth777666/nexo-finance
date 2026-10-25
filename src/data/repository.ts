import type {
  Account,
  AlertState,
  AlertStatusRecord,
  AuditEntry,
  Category,
  Company,
  CompanyInvite,
  CompanyMember,
  InviteRole,
  Transaction,
} from '@/domain/types'
import type { AlertConfig } from '@/domain/finance/alerts'
import type { AccountBalance, MonthPoint } from '@/domain/finance/metrics'
import type { ValidTransaction } from '@/domain/transactions'
import type { Decision } from '@/domain/finance/simulation'
import type { ScenarioAssumptions } from '@/domain/finance/projection'
import type { Cents } from '@/lib/money'
import type { ISODate } from '@/lib/dates'
import type { AgentKind, AnalysisResult, Facts, Review } from '@/domain/ai/analysis'

/**
 * Contrato de acesso a dados. A interface não sabe se os dados vêm do modo de demonstração
 * (navegador, isolado) ou do Supabase (Fase 3). Toda operação é escopada a uma única empresa:
 * no Supabase, o isolamento é garantido por RLS no banco — não por este código.
 */
export interface ImportRecord {
  id: string
  fileName: string
  fileHash: string
  at: string
  actor: string
  totalRows: number
  imported: number
  skipped: number
  errors: number
  warnings: number
}

export interface SavedScenario {
  id: string
  name: string
  createdAt: string
  horizonDays: number
  decisions: Decision[]
  /** Resultado no momento em que foi salvo (para relatório), com a data de referência. */
  asOf: string
  resultSummary: { currentMin: number; alternativeMin: number; endDelta: number; firstNegative: string | null }
}

export interface CreateInviteInput {
  email: string
  role: InviteRole
}

/** Agregados diários da projeção-base. Os detalhes por evento ficam no domínio, não no banco. */
export interface BaseProjectionDay {
  date: ISODate
  inflow: Cents
  outflow: Cents
  balance: Cents
}

/** Resultado de `base_projection` (BASE_SCENARIO): resumo + série diária, sem eventos detalhados. */
export interface BaseProjection {
  asOf: ISODate
  endDate: ISODate
  horizonDays: number
  startBalance: Cents
  endBalance: Cents
  totalIn: Cents
  totalOut: Cents
  minBalance: Cents
  minDate: ISODate
  firstNegativeDate: ISODate | null
  negativeDays: number
  lastInflowDate: ISODate | null
  days: BaseProjectionDay[]
  pressureDays: BaseProjectionDay[]
  excluded: {
    overdueReceivables: { amount: Cents; count: number }
    beyondHorizon: { amount: Cents; count: number }
  }
}

export interface AiAnalysisResponse {
  analysis: AnalysisResult
  facts: Facts
  review: Review
  status: 'ok' | 'rejected'
  cached: boolean
  provider?: string
  model?: string
}

export interface CompanySnapshot {
  company: Company
  accounts: Account[]
  categories: Category[]
  transactions: Transaction[]
  alertStatus: Record<string, AlertStatusRecord>
  audit: AuditEntry[]
  imports: ImportRecord[]
  scenarios: SavedScenario[]
  alertConfig: AlertConfig
  customScenario: ScenarioAssumptions
  /** Data em que a base foi criada (modo demo: datas relativas a ela). */
  anchor: string
}

export interface FinanceRepository {
  readonly mode: 'demo' | 'supabase'
  load(): Promise<CompanySnapshot>
  createTransaction(input: ValidTransaction): Promise<Transaction>
  updateTransaction(id: string, input: ValidTransaction): Promise<Transaction>
  deleteTransaction(id: string): Promise<void>
  importTransactions(rows: ValidTransaction[], meta: Omit<ImportRecord, 'id' | 'at' | 'actor'>): Promise<ImportRecord>
  setAlertState(fingerprint: string, state: AlertState, note?: string): Promise<AlertStatusRecord>
  saveAlertConfig(config: AlertConfig): Promise<void>
  saveCustomScenario(s: ScenarioAssumptions): Promise<void>
  addCategory(c: Omit<Category, 'id'>): Promise<Category>
  updateCompanyName(name: string): Promise<Company>
  updateAccountOpeningBalance(accountId: string, openingBalance: Cents): Promise<Account>
  saveScenario(s: Omit<SavedScenario, 'id' | 'createdAt'>): Promise<SavedScenario>
  deleteScenario(id: string): Promise<void>
  listMembers(): Promise<CompanyMember[]>
  listInvites(): Promise<CompanyInvite[]>
  createInvite(input: CreateInviteInput): Promise<CompanyInvite>
  revokeInvite(id: string): Promise<void>
  updateMemberRole(userId: string, role: InviteRole): Promise<CompanyMember>
  removeMember(userId: string): Promise<void>
  reset(): Promise<CompanySnapshot>
  /** Saldo registrado por conta na data (mesma definição de metrics.accountBalances). */
  getAccountBalances(asOf: ISODate): Promise<AccountBalance[]>
  /** Evolução mensal em regime de caixa (metrics.monthlyEvolution). */
  getMonthlyEvolution(asOf: ISODate, months?: number): Promise<MonthPoint[]>
  /** Projeção-base (projection.projectCashflow com BASE_SCENARIO), sem eventos detalhados. */
  getBaseProjection(asOf: ISODate, horizonDays: number): Promise<BaseProjection>
  /** Análise por agente. No demo é local; no Supabase é gerada na Edge Function. */
  requestAnalysis(agent: AgentKind): Promise<AiAnalysisResponse>
}

export class RepositoryError extends Error {}
