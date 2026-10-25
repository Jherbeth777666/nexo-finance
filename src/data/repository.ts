import type {
  Account,
  AlertState,
  AlertStatusRecord,
  AuditEntry,
  Category,
  Company,
  Transaction,
} from '@/domain/types'
import type { AlertConfig } from '@/domain/finance/alerts'
import type { ValidTransaction } from '@/domain/transactions'
import type { Decision } from '@/domain/finance/simulation'
import type { ScenarioAssumptions } from '@/domain/finance/projection'

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
  saveScenario(s: Omit<SavedScenario, 'id' | 'createdAt'>): Promise<SavedScenario>
  deleteScenario(id: string): Promise<void>
  reset(): Promise<CompanySnapshot>
}

export class RepositoryError extends Error {}
