import type { Account, AlertState, AuditEntry, Company, CompanyInvite, CompanyMember, InviteRole, Transaction } from '@/domain/types'
import { DEFAULT_ALERT_CONFIG } from '@/domain/finance/alerts'
import { CONSERVATIVE_SCENARIO } from '@/domain/finance/projection'
import type { ValidTransaction } from '@/domain/transactions'
import { validateCompanyName, validateInviteEmail, validateInviteRole, validateOpeningBalance } from '@/domain/company'
import { addDays, todayIn } from '@/lib/dates'
import { assertCents, formatBRL, type Cents } from '@/lib/money'
import { buildDemoDataset } from './demo/seed'
import { RepositoryError, type CompanySnapshot, type CreateInviteInput, type FinanceRepository } from './repository'

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

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Estado interno do demo: o snapshot visível + a equipe (persistida junto, mesma chave). */
interface DemoState extends CompanySnapshot {
  members: CompanyMember[]
  invites: CompanyInvite[]
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
    if (
      s.invites.some(
        (i) => i.email === email.value && !i.acceptedAt && !i.revokedAt && new Date(i.expiresAt).getTime() > now,
      )
    ) {
      throw new RepositoryError('Já existe um convite ativo para este e-mail.')
    }
    // Convites antigos/expirados do mesmo e-mail deixam de ser pendentes.
    s.invites = s.invites.map((i) =>
      i.email === email.value && !i.acceptedAt && !i.revokedAt ? { ...i, revokedAt: new Date(now).toISOString() } : i,
    )
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

  async reset(): Promise<CompanySnapshot> {
    this.state = fresh()
    this.audit({ action: 'reset', entity: 'company', entityId: this.state.company.id, summary: 'Reinicializou os dados de demonstração' })
    this.write()
    return structuredClone(this.state)
  }
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
