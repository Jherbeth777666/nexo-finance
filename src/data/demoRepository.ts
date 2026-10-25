import type {
  Account,
  AlertState,
  AuditEntry,
  Category,
  Company,
  CompanyInvite,
  CompanyMember,
  InviteRole,
  LocalEvent,
  Product,
  ProductSale,
  Transaction,
} from '@/domain/types'
import { DEFAULT_ALERT_CONFIG } from '@/domain/finance/alerts'
import { accountBalances, monthlyEvolution } from '@/domain/finance/metrics'
import { BASE_SCENARIO, CONSERVATIVE_SCENARIO, projectCashflow } from '@/domain/finance/projection'
import type { ValidTransaction } from '@/domain/transactions'
import { validateCompanyName, validateInviteEmail, validateInviteRole, validateOpeningBalance } from '@/domain/company'
import { addDays, isISODate, todayIn, type ISODate } from '@/lib/dates'
import { assertCents, formatBRL, type Cents } from '@/lib/money'
import { buildLocalAnalysis } from '@/domain/ai/analysis'
import type { CategoryTotal } from '@/domain/ai/facts'
import { norm, IMPORT_LIMITS } from '@/domain/import/pipeline'
import { productKey, type NewProductSale } from '@/domain/products/mapping'
import { buildDemoDataset } from './demo/seed'
import {
  RepositoryError,
  type BaseProjection,
  type CompanySnapshot,
  type CreateInviteInput,
  type FinanceRepository,
  type ImportRecord,
  type SaveLocalEventInput,
  type SaveProductInput,
} from './repository'

/**
 * Repositório do modo de demonstração. Os dados ficam SOMENTE no navegador do visitante,
 * sob uma chave própria, e nunca se misturam com dados de produção (que viverão no Supabase).
 * Se o armazenamento local estiver bloqueado, funciona em memória e avisa a interface.
 */
const KEY = 'nexo.demo.v1'
const ACTOR = 'Visitante (demonstração)'

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Estado interno do demo: o snapshot visível + a equipe (persistida junto, mesma chave). */
interface DemoState extends CompanySnapshot {
  members: CompanyMember[]
  invites: CompanyInvite[]
  productSales: ProductSale[]
}

function demoMembers(today: string): CompanyMember[] {
  return [
    { userId: 'demo-owner', name: 'Você (demonstração)', email: 'voce@exemplo.com.br', role: 'owner', joinedAt: addDays(today, -182) },
    { userId: 'demo-member', name: 'Marina Costa (fictícia)', email: 'marina@exemplo.com.br', role: 'member', joinedAt: addDays(today, -90) },
    { userId: 'demo-viewer', name: 'Contador (fictício)', email: 'contador@exemplo.com.br', role: 'viewer', joinedAt: addDays(today, -30) },
  ]
}

function fresh(): DemoState {
  const today = todayIn()
  const ds = buildDemoDataset(today)
  return {
    company: ds.company,
    accounts: ds.accounts,
    categories: ds.categories,
    transactions: ds.transactions,
    products: ds.products,
    productSales: ds.productSales,
    localEvents: ds.localEvents,
    alertStatus: {},
    audit: [],
    imports: [],
    scenarios: [],
    alertConfig: DEFAULT_ALERT_CONFIG,
    customScenario: { ...CONSERVATIVE_SCENARIO, id: 'custom', receivableDelayDays: 14, receivableHaircutPct: 0 },
    anchor: today,
    members: demoMembers(today),
    invites: [],
  }
}

export class DemoRepository implements FinanceRepository {
  readonly mode = 'demo' as const
  persistent = true
  private state: DemoState | null = null
  constructor(private storage: Storage | null = safeStorage()) {
    if (!storage) this.persistent = false
  }

  private read(): DemoState {
    if (this.state) return this.state
    let parsed: DemoState | null = null
    try {
      const raw = this.storage?.getItem(KEY)
      if (raw) parsed = JSON.parse(raw) as DemoState
      if (parsed && (!parsed.company?.isDemo || !Array.isArray(parsed.transactions))) parsed = null
    } catch {
      parsed = null
    }
    this.state = parsed ?? fresh()
    // Dados salvos por versões anteriores não tinham equipe: completa sem perder o restante.
    let patched = !parsed
    if (!Array.isArray(this.state.members)) {
      this.state.members = demoMembers(this.state.anchor)
      patched = true
    }
    if (!Array.isArray(this.state.invites)) {
      this.state.invites = []
      patched = true
    }
    if (!this.state.company.role) {
      this.state.company.role = 'owner'
      patched = true
    }
    if (!Array.isArray(this.state.products) || !Array.isArray(this.state.localEvents) || !Array.isArray(this.state.productSales)) {
      const pd = buildDemoDataset(this.state.anchor)
      if (!Array.isArray(this.state.products)) this.state.products = pd.products
      if (!Array.isArray(this.state.localEvents)) this.state.localEvents = pd.localEvents
      if (!Array.isArray(this.state.productSales)) this.state.productSales = pd.productSales
      patched = true
    }
    if (patched) this.write()
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

  private snapshot(): CompanySnapshot {
    const { members: _members, invites: _invites, productSales: _productSales, ...snap } = this.read()
    return structuredClone(snap)
  }

  async load(): Promise<CompanySnapshot> {
    return this.snapshot()
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

  async updateCompanyName(name: string): Promise<Company> {
    const valid = validateCompanyName(name)
    if (!valid.ok) throw new RepositoryError(valid.error)
    const s = this.read()
    s.company = { ...s.company, name: valid.value }
    this.audit({ action: 'update', entity: 'company', entityId: s.company.id, summary: `Renomeou a empresa para "${valid.value}"` })
    this.write()
    return structuredClone(s.company)
  }

  async updateAccountOpeningBalance(accountId: string, openingBalance: Cents): Promise<Account> {
    const valid = validateOpeningBalance(openingBalance)
    if (!valid.ok) throw new RepositoryError(valid.error)
    const value = assertCents(valid.value)
    const s = this.read()
    const prev = s.accounts.find((a) => a.id === accountId)
    if (!prev) throw new RepositoryError('Conta não encontrada')
    const account = { ...prev, openingBalance: value }
    s.accounts = s.accounts.map((a) => (a.id === accountId ? account : a))
    this.audit({
      action: 'update',
      entity: 'account',
      entityId: accountId,
      summary: `Alterou o saldo de abertura de "${account.name}" para ${formatBRL(value)}`,
    })
    this.write()
    return structuredClone(account)
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

  async listMembers(): Promise<CompanyMember[]> {
    return structuredClone(this.read().members)
  }

  async listInvites(): Promise<CompanyInvite[]> {
    return structuredClone(this.read().invites)
  }

  async createInvite(input: CreateInviteInput): Promise<CompanyInvite> {
    const email = validateInviteEmail(input.email)
    if (!email.ok) throw new RepositoryError(email.error)
    const role = validateInviteRole(input.role)
    if (!role.ok) throw new RepositoryError(role.error)
    const s = this.read()
    if (s.members.some((m) => m.email?.toLowerCase() === email.value)) {
      throw new RepositoryError('Este e-mail já faz parte da equipe.')
    }
    const now = Date.now()
    if (s.invites.some((i) => i.email === email.value && !i.acceptedAt && !i.revokedAt && new Date(i.expiresAt).getTime() > now)) {
      throw new RepositoryError('Já existe um convite ativo para este e-mail.')
    }
    // Convites antigos/expirados do mesmo e-mail deixam de ser pendentes.
    s.invites = s.invites.map((i) => (i.email === email.value && !i.acceptedAt && !i.revokedAt ? { ...i, revokedAt: new Date(now).toISOString() } : i))
    const id = uid()
    const invite: CompanyInvite = {
      id,
      email: email.value,
      role: role.value,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
      acceptedAt: null,
      revokedAt: null,
      // No modo demo não há fluxo real de aceite; o link apenas explica a limitação.
      token: `demo-${id}`,
    }
    s.invites = [invite, ...s.invites]
    this.audit({
      action: 'create',
      entity: 'invite',
      entityId: id,
      summary: `Convidou ${invite.email} como ${roleLabel(invite.role)}`,
    })
    this.write()
    return structuredClone(invite)
  }

  async revokeInvite(id: string): Promise<void> {
    const s = this.read()
    const invite = s.invites.find((i) => i.id === id)
    if (!invite) throw new RepositoryError('Convite não encontrado.')
    if (invite.acceptedAt) throw new RepositoryError('Este convite já foi aceito.')
    if (invite.revokedAt) return
    invite.revokedAt = new Date().toISOString()
    this.audit({ action: 'update', entity: 'invite', entityId: id, summary: `Revogou o convite de ${invite.email}` })
    this.write()
  }

  async updateMemberRole(userId: string, role: InviteRole): Promise<CompanyMember> {
    const valid = validateInviteRole(role)
    if (!valid.ok) throw new RepositoryError(valid.error)
    const s = this.read()
    const member = s.members.find((m) => m.userId === userId)
    if (!member) throw new RepositoryError('Membro não encontrado.')
    if (member.role === 'owner') throw new RepositoryError('O proprietário não pode ser alterado.')
    const previous = member.role
    member.role = valid.value
    this.audit({
      action: 'update',
      entity: 'member',
      entityId: userId,
      summary: `Alterou o papel de ${member.name} de ${roleLabel(previous)} para ${roleLabel(valid.value)}`,
    })
    this.write()
    return structuredClone(member)
  }

  async removeMember(userId: string): Promise<void> {
    const s = this.read()
    const member = s.members.find((m) => m.userId === userId)
    if (!member) throw new RepositoryError('Membro não encontrado.')
    if (member.role === 'owner') throw new RepositoryError('O proprietário não pode ser removido.')
    s.members = s.members.filter((m) => m.userId !== userId)
    this.audit({ action: 'delete', entity: 'member', entityId: userId, summary: `Removeu ${member.name} da equipe` })
    this.write()
  }

  async getAccountBalances(asOf: string) {
    const s = this.read()
    return structuredClone(accountBalances(s.accounts, s.transactions, asOf))
  }

  async getMonthlyEvolution(asOf: string, months = 6) {
    const s = this.read()
    return structuredClone(monthlyEvolution(s.accounts, s.transactions, asOf, months))
  }

  async getBaseProjection(asOf: string, horizonDays: number): Promise<BaseProjection> {
    const s = this.read()
    const p = projectCashflow({ accounts: s.accounts, transactions: s.transactions, asOf, horizonDays, assumptions: BASE_SCENARIO })
    const day = ({ date, inflow, outflow, balance }: (typeof p.days)[number]) => ({ date, inflow, outflow, balance })
    return {
      asOf: p.asOf,
      endDate: p.endDate,
      horizonDays: p.horizonDays,
      startBalance: p.startBalance,
      endBalance: p.endBalance,
      totalIn: p.totalIn,
      totalOut: p.totalOut,
      minBalance: p.minBalance,
      minDate: p.minDate,
      firstNegativeDate: p.firstNegativeDate,
      negativeDays: p.negativeDays,
      lastInflowDate: p.lastInflowDate,
      days: p.days.map(day),
      pressureDays: p.pressureDays.map(day),
      excluded: {
        overdueReceivables: p.excluded.overdueReceivables,
        beyondHorizon: p.excluded.beyondHorizon,
      },
    }
  }

  async requestAnalysis(agent: Parameters<FinanceRepository['requestAnalysis']>[0]) {
    const s = this.read()
    const asOf = todayIn(s.company.timezone)
    const projection = projectCashflow({ accounts: s.accounts, transactions: s.transactions, asOf, horizonDays: 30, assumptions: BASE_SCENARIO })
    const result = buildLocalAnalysis(agent, {
      asOf,
      projection,
      categoryTotals: categoryTotals(s.categories, s.transactions, asOf, 90),
      scenarios: s.scenarios.map((sc) => ({ horizonDays: sc.horizonDays, asOf: sc.asOf, resultSummary: sc.resultSummary })),
    })
    return {
      analysis: result.analysis,
      facts: result.facts,
      review: result.review,
      status: result.review.valid ? ('ok' as const) : ('rejected' as const),
      cached: false,
      provider: 'local-rules',
    }
  }

  async listProductSales(from: string, to: string): Promise<ProductSale[]> {
    const s = this.read()
    return structuredClone(
      s.productSales
        .filter((sale) => sale.saleDate >= from && sale.saleDate <= to)
        .sort((a, b) => a.saleDate.localeCompare(b.saleDate) || a.id.localeCompare(b.id)),
    )
  }

  async existingProductSaleRefs(sourceRefs: string[]): Promise<string[]> {
    const unique = [...new Set(sourceRefs.filter(Boolean))]
    if (!unique.length) return []
    const wanted = new Set(unique)
    const existing = new Set(
      this.read()
        .productSales.map((sale) => sale.sourceRef)
        .filter((ref): ref is string => !!ref && wanted.has(ref)),
    )
    return unique.filter((ref) => existing.has(ref))
  }

  async saveProduct(input: SaveProductInput): Promise<Product> {
    const name = input.name.trim()
    if (name.length < 2 || name.length > 120) throw new RepositoryError('O nome do produto deve ter entre 2 e 120 caracteres.')
    const unit = (input.unit ?? 'un').trim() || 'un'
    if (unit.length > 10) throw new RepositoryError('A unidade deve ter no máximo 10 caracteres.')
    const code = input.code?.trim() || null
    if (code && code.length > 40) throw new RepositoryError('O código deve ter no máximo 40 caracteres.')
    const costPrice = validateOptionalCents(input.costPrice, 'custo')
    const stock = validateOptionalQuantity(input.stock, 'estoque')
    const minStock = validateOptionalQuantity(input.minStock, 'estoque mínimo')
    const leadTimeDays = input.leadTimeDays === null ? null : Math.trunc(input.leadTimeDays)
    if (leadTimeDays !== null && (leadTimeDays < 0 || leadTimeDays > 365)) throw new RepositoryError('O prazo do fornecedor deve ficar entre 0 e 365 dias.')
    const s = this.read()
    const today = todayIn(s.company.timezone)
    if (input.stock !== null && input.stockUpdatedAt && isISODate(input.stockUpdatedAt) && input.stockUpdatedAt > today) {
      throw new RepositoryError('A data do estoque não pode estar no futuro.')
    }
    const stockUpdatedAt = stock === null ? null : input.stockUpdatedAt && isISODate(input.stockUpdatedAt) ? input.stockUpdatedAt : today
    const now = new Date().toISOString()
    if (input.id) {
      const prev = s.products.find((p) => p.id === input.id)
      if (!prev) throw new RepositoryError('Produto não encontrado.')
      if (s.products.some((p) => p.id !== prev.id && productKey(p.name) === productKey(name))) {
        throw new RepositoryError('Já existe um produto com esse nome.')
      }
      if (code && s.products.some((p) => p.id !== prev.id && p.code && norm(p.code) === norm(code))) {
        throw new RepositoryError('Já existe um produto com esse código.')
      }
      const product: Product = {
        ...prev,
        name,
        code,
        unit,
        costPrice,
        stock,
        stockUpdatedAt,
        minStock,
        leadTimeDays,
        updatedAt: now,
      }
      s.products = s.products.map((p) => (p.id === prev.id ? product : p))
      this.audit({ action: 'update', entity: 'product', entityId: product.id, summary: `Atualizou o produto "${product.name}"` })
      this.write()
      return structuredClone(product)
    }
    if (s.products.some((p) => productKey(p.name) === productKey(name))) throw new RepositoryError('Já existe um produto com esse nome.')
    if (code && s.products.some((p) => p.code && norm(p.code) === norm(code))) throw new RepositoryError('Já existe um produto com esse código.')
    const product: Product = {
      id: uid(),
      name,
      code,
      unit,
      costPrice,
      stock,
      stockUpdatedAt,
      minStock,
      leadTimeDays,
      createdAt: now,
      updatedAt: now,
    }
    s.products = [...s.products, product]
    this.audit({ action: 'create', entity: 'product', entityId: product.id, summary: `Cadastrou o produto "${product.name}"` })
    this.write()
    return structuredClone(product)
  }

  async importProductSales(rows: NewProductSale[], meta: Parameters<FinanceRepository['importProductSales']>[1]): Promise<ImportRecord> {
    if (!rows.length) throw new RepositoryError('Nenhuma venda válida para importar.')
    if (rows.length > IMPORT_LIMITS.maxRows) throw new RepositoryError(`O limite por importação é ${IMPORT_LIMITS.maxRows} linhas.`)
    const s = this.read()
    const existingRefs = new Set(s.productSales.map((sale) => sale.sourceRef).filter(Boolean))
    const batchRefs = new Set<string>()
    const id = uid()
    const now = new Date().toISOString()
    const created: ProductSale[] = []
    // Espelha cost_updated_at do banco: a data da última venda que informou custo é a referência
    // para aceitar um novo custo, e o melhor custo do lote vem da venda mais recente (não da
    // última linha da planilha).
    const lastCostDateByProduct = new Map<string, ISODate>()
    for (const sale of s.productSales) {
      if (sale.unitCost === null) continue
      const last = lastCostDateByProduct.get(sale.productId)
      if (!last || sale.saleDate > last) lastCostDateByProduct.set(sale.productId, sale.saleDate)
    }
    const bestCost = new Map<string, { date: ISODate; cost: Cents; order: number }>()
    for (const [order, row] of rows.entries()) {
      if (!row.sourceRef) throw new RepositoryError('Venda sem identificador de origem.')
      if (existingRefs.has(row.sourceRef) || batchRefs.has(row.sourceRef)) {
        throw new RepositoryError('Uma venda com a mesma origem já foi importada.')
      }
      if (!isISODate(row.saleDate) || row.saleDate > todayIn(s.company.timezone)) throw new RepositoryError('Data de venda inválida.')
      if (!Number.isInteger(row.quantity) || row.quantity <= 0) throw new RepositoryError('Quantidade de venda inválida.')
      if (!Number.isInteger(row.revenue) || row.revenue < 0) throw new RepositoryError('Receita de venda inválida.')
      let product = row.productId ? s.products.find((p) => p.id === row.productId) : undefined
      if (!product && row.productCode) product = s.products.find((p) => p.code && norm(p.code) === norm(row.productCode!))
      if (!product) product = s.products.find((p) => productKey(p.name) === productKey(row.productName))
      if (!product) {
        const freshProduct: Product = {
          id: uid(),
          name: row.productName.slice(0, 120),
          code: row.productCode,
          unit: 'un',
          costPrice: null,
          stock: row.stock,
          stockUpdatedAt: row.stock === null ? null : row.saleDate,
          minStock: null,
          leadTimeDays: null,
          createdAt: now,
          updatedAt: now,
        }
        s.products = [...s.products, freshProduct]
        product = freshProduct
        this.audit({ action: 'create', entity: 'product', entityId: product.id, summary: `Criou "${product.name}" na importação de vendas` })
      } else {
        const updates: Partial<Product> = { updatedAt: now }
        if (row.stock !== null && (!product.stockUpdatedAt || row.saleDate >= product.stockUpdatedAt)) {
          updates.stock = row.stock
          updates.stockUpdatedAt = row.saleDate
        }
        if (Object.keys(updates).length > 1) {
          s.products = s.products.map((p) => (p.id === product!.id ? { ...p, ...updates } : p))
          product = s.products.find((p) => p.id === product!.id)!
        }
      }
      const sale: ProductSale = {
        id: uid(),
        productId: product.id,
        saleDate: row.saleDate,
        quantity: row.quantity,
        revenue: row.revenue,
        unitCost: row.unitCost,
        sourceRef: row.sourceRef,
        importId: id,
        createdAt: now,
      }
      created.push(sale)
      existingRefs.add(row.sourceRef)
      batchRefs.add(row.sourceRef)
      if (row.unitCost !== null) {
        const current = bestCost.get(product.id)
        if (!current || row.saleDate > current.date || (row.saleDate === current.date && order >= current.order)) {
          bestCost.set(product.id, { date: row.saleDate, cost: row.unitCost, order })
        }
      }
    }
    for (const [productId, best] of bestCost) {
      const product = s.products.find((p) => p.id === productId)
      if (!product) continue
      const lastCostDate = lastCostDateByProduct.get(productId)
      if (product.costPrice === null || !lastCostDate || best.date >= lastCostDate) {
        product.costPrice = best.cost
        product.updatedAt = now
      }
    }
    s.productSales = [...s.productSales, ...created]
    const record = { ...meta, id, at: now, actor: ACTOR }
    s.imports = [record, ...s.imports]
    this.audit({ action: 'import', entity: 'import', entityId: id, summary: `Importou ${created.length} venda(s) de produto de "${meta.fileName}"` })
    this.write()
    return structuredClone(record)
  }

  async saveLocalEvent(input: SaveLocalEventInput): Promise<LocalEvent> {
    const name = input.name.trim()
    if (name.length < 2 || name.length > 120) throw new RepositoryError('O nome do evento deve ter entre 2 e 120 caracteres.')
    if (!isISODate(input.startDate)) throw new RepositoryError('Data inicial do evento inválida.')
    const endDate = input.endDate ?? null
    if (endDate !== null && (!isISODate(endDate) || endDate < input.startDate)) throw new RepositoryError('Data final do evento inválida.')
    const s = this.read()
    const event: LocalEvent = {
      id: uid(),
      name,
      startDate: input.startDate,
      endDate,
      kind: input.kind ?? 'local',
      createdAt: new Date().toISOString(),
    }
    s.localEvents = [...s.localEvents, event].sort((a, b) => a.startDate.localeCompare(b.startDate))
    this.audit({ action: 'create', entity: 'local_event', entityId: event.id, summary: `Cadastrou o evento "${event.name}"` })
    this.write()
    return structuredClone(event)
  }

  async reset(): Promise<CompanySnapshot> {
    this.state = fresh()
    this.audit({ action: 'reset', entity: 'company', entityId: this.state.company.id, summary: 'Reinicializou os dados de demonstração' })
    this.write()
    return this.snapshot()
  }
}

function categoryTotals(categories: Category[], transactions: Transaction[], asOf: string, days: number): CategoryTotal[] {
  const start = addDays(asOf, -(days - 1))
  const byId = new Map(categories.map((c) => [c.id, c]))
  const totals = new Map<string, CategoryTotal>()
  for (const tx of transactions) {
    if (tx.status === 'cancelled' || tx.kind === 'transfer' || !tx.categoryId) continue
    if (tx.competenceDate < start || tx.competenceDate > asOf) continue
    const category = byId.get(tx.categoryId)
    if (!category) continue
    const current = totals.get(category.id) ?? { name: category.name, kind: category.kind, total: 0 }
    current.total += tx.amount
    totals.set(category.id, current)
  }
  return [...totals.values()]
}

function roleLabel(role: InviteRole | 'owner'): string {
  return { owner: 'proprietário', admin: 'administrador', member: 'membro', viewer: 'somente leitura' }[role]
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

function validateOptionalCents(value: Cents | null, label: string): Cents | null {
  if (value === null) return null
  if (!Number.isInteger(value) || value < 0) throw new RepositoryError(`O ${label} deve ser um valor em centavos, sem negativos.`)
  return assertCents(value)
}

function validateOptionalQuantity(value: number | null, label: string): number | null {
  if (value === null) return null
  if (!Number.isInteger(value) || value < 0) throw new RepositoryError(`O ${label} deve ser informado em milésimos inteiros, sem negativos.`)
  return value
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
