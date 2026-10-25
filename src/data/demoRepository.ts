import type { AlertState, AuditEntry, Transaction } from '@/domain/types'
import { DEFAULT_ALERT_CONFIG } from '@/domain/finance/alerts'
import { CONSERVATIVE_SCENARIO } from '@/domain/finance/projection'
import type { ValidTransaction } from '@/domain/transactions'
import { todayIn } from '@/lib/dates'
import { buildDemoDataset } from './demo/seed'
import { RepositoryError, type CompanySnapshot, type FinanceRepository } from './repository'

/**
 * Repositório do modo de demonstração. Os dados ficam SOMENTE no navegador do visitante,
 * sob uma chave própria, e nunca se misturam com dados de produção (que viverão no Supabase).
 * Se o armazenamento local estiver bloqueado, funciona em memória e avisa a interface.
 */
const KEY = 'nexo.demo.v1'
const ACTOR = 'Visitante (demonstração)'

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

function fresh(): CompanySnapshot {
  const today = todayIn()
  const ds = buildDemoDataset(today)
  return {
    company: ds.company,
    accounts: ds.accounts,
    categories: ds.categories,
    transactions: ds.transactions,
    alertStatus: {},
    audit: [],
    imports: [],
    scenarios: [],
    alertConfig: DEFAULT_ALERT_CONFIG,
    customScenario: { ...CONSERVATIVE_SCENARIO, id: 'custom', receivableDelayDays: 14, receivableHaircutPct: 0 },
    anchor: today,
  }
}

export class DemoRepository implements FinanceRepository {
  readonly mode = 'demo' as const
  persistent = true
  private state: CompanySnapshot | null = null
  constructor(private storage: Storage | null = safeStorage()) {
    if (!storage) this.persistent = false
  }

  private read(): CompanySnapshot {
    if (this.state) return this.state
    let parsed: CompanySnapshot | null = null
    try {
      const raw = this.storage?.getItem(KEY)
      if (raw) parsed = JSON.parse(raw) as CompanySnapshot
      if (parsed && (!parsed.company?.isDemo || !Array.isArray(parsed.transactions))) parsed = null
    } catch {
      parsed = null
    }
    this.state = parsed ?? fresh()
    if (!parsed) this.write()
    return this.state
  }

  private write() {
    if (!this.state || !this.storage) return
    try {
      this.storage.setItem(KEY, JSON.stringify(this.state))
    } catch {
      this.persistent = false
    }
  }

  private audit(e: Omit<AuditEntry, 'id' | 'at' | 'actor'>) {
    const s = this.read()
    s.audit = [{ id: uid(), at: new Date().toISOString(), actor: ACTOR, ...e }, ...s.audit].slice(0, 500)
  }

  async load(): Promise<CompanySnapshot> {
    return structuredClone(this.read())
  }

  async createTransaction(input: ValidTransaction): Promise<Transaction> {
    const s = this.read()
    const now = new Date().toISOString()
    const tx: Transaction = { ...input, id: uid(), source: 'manual', createdAt: now, updatedAt: now }
    s.transactions = [...s.transactions, tx]
    this.audit({ action: 'create', entity: 'transaction', entityId: tx.id, summary: `Criou "${tx.description}"` })
    this.write()
    return structuredClone(tx)
  }

  async updateTransaction(id: string, input: ValidTransaction): Promise<Transaction> {
    const s = this.read()
    const prev = s.transactions.find((t) => t.id === id)
    if (!prev) throw new RepositoryError('Lançamento não encontrado')
    const tx: Transaction = { ...prev, ...input, id, updatedAt: new Date().toISOString() }
    s.transactions = s.transactions.map((t) => (t.id === id ? tx : t))
    this.audit({ action: 'update', entity: 'transaction', entityId: id, summary: describeChanges(prev, tx) })
    this.write()
    return structuredClone(tx)
  }

  async deleteTransaction(id: string): Promise<void> {
    const s = this.read()
    const prev = s.transactions.find((t) => t.id === id)
    if (!prev) throw new RepositoryError('Lançamento não encontrado')
    s.transactions = s.transactions.filter((t) => t.id !== id)
    this.audit({ action: 'delete', entity: 'transaction', entityId: id, summary: `Excluiu "${prev.description}"` })
    this.write()
  }

  async importTransactions(rows: ValidTransaction[], meta: Parameters<FinanceRepository['importTransactions']>[1]) {
    const s = this.read()
    const id = uid()
    const now = new Date().toISOString()
    const created: Transaction[] = rows.map((r) => ({ ...r, id: uid(), source: 'import', importId: id, createdAt: now, updatedAt: now }))
    s.transactions = [...s.transactions, ...created]
    const record = { ...meta, id, at: now, actor: ACTOR }
    s.imports = [record, ...s.imports]
    this.audit({ action: 'import', entity: 'import', entityId: id, summary: `Importou ${created.length} lançamento(s) de "${meta.fileName}"` })
    this.write()
    return structuredClone(record)
  }

  async setAlertState(fingerprint: string, state: AlertState, note?: string) {
    const s = this.read()
    const rec = { fingerprint, state, note, updatedAt: new Date().toISOString() }
    s.alertStatus = { ...s.alertStatus, [fingerprint]: rec }
    this.audit({ action: 'alert_state', entity: 'alert', entityId: fingerprint, summary: `Alerta marcado como "${state}"` })
    this.write()
    return rec
  }

  async saveAlertConfig(config: CompanySnapshot['alertConfig']) {
    this.read().alertConfig = config
    this.audit({ action: 'update', entity: 'settings', entityId: 'alert_config', summary: 'Alterou limites dos alertas' })
    this.write()
  }

  async saveCustomScenario(sc: CompanySnapshot['customScenario']) {
    this.read().customScenario = sc
    this.write()
  }

  async addCategory(c: Parameters<FinanceRepository['addCategory']>[0]) {
    const s = this.read()
    if (s.categories.some((x) => x.name.trim().toLowerCase() === c.name.trim().toLowerCase() && x.kind === c.kind))
      throw new RepositoryError('Já existe uma categoria com esse nome')
    const cat = { ...c, id: uid() }
    s.categories = [...s.categories, cat]
    this.audit({ action: 'create', entity: 'category', entityId: cat.id, summary: `Criou a categoria "${cat.name}"` })
    this.write()
    return cat
  }

  async saveScenario(sc: Parameters<FinanceRepository['saveScenario']>[0]) {
    const s = this.read()
    const saved = { ...sc, id: uid(), createdAt: new Date().toISOString() }
    s.scenarios = [saved, ...s.scenarios].slice(0, 50)
    this.write()
    return structuredClone(saved)
  }

  async deleteScenario(id: string) {
    const s = this.read()
    s.scenarios = s.scenarios.filter((x) => x.id !== id)
    this.write()
  }

  async reset(): Promise<CompanySnapshot> {
    this.state = fresh()
    this.audit({ action: 'reset', entity: 'company', entityId: this.state.company.id, summary: 'Reinicializou os dados de demonstração' })
    this.write()
    return structuredClone(this.state)
  }
}

function describeChanges(a: Transaction, b: Transaction): string {
  const fields: [keyof Transaction, string][] = [
    ['amount', 'valor'],
    ['status', 'situação'],
    ['dueDate', 'vencimento'],
    ['settledDate', 'liquidação'],
    ['categoryId', 'categoria'],
    ['description', 'descrição'],
    ['competenceDate', 'competência'],
  ]
  const changed = fields.filter(([k]) => a[k] !== b[k]).map(([, l]) => l)
  return changed.length ? `Alterou ${changed.join(', ')} de "${b.description}"` : `Salvou "${b.description}" sem alterações`
}

function safeStorage(): Storage | null {
  try {
    const s = globalThis.localStorage
    const k = '__nexo_probe__'
    s.setItem(k, '1')
    s.removeItem(k)
    return s
  } catch {
    return null
  }
}
