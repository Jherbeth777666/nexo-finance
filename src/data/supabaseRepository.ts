import type { SupabaseClient } from '@supabase/supabase-js'
import type { Account, AlertState, AuditEntry, Category, Company, CompanyInvite, CompanyMember, InviteRole, MemberRole, Transaction } from '@/domain/types'
import { DEFAULT_ALERT_CONFIG, type AlertConfig } from '@/domain/finance/alerts'
import { CONSERVATIVE_SCENARIO, type ScenarioAssumptions } from '@/domain/finance/projection'
import { validateCompanyName, validateInviteEmail, validateInviteRole, validateOpeningBalance } from '@/domain/company'
import type { ValidTransaction } from '@/domain/transactions'
import { todayIn } from '@/lib/dates'
import type { Cents } from '@/lib/money'
import { RepositoryError, type CompanySnapshot, type CreateInviteInput, type FinanceRepository, type ImportRecord, type SavedScenario } from './repository'
import { TX_COLUMNS, centsToNumeric, friendlyDbError, numericToCents, rowToTransaction, transactionToRow, type TxRow } from './supabaseMapping'

/**
 * Repositório de dados reais. Cada instância é presa a UMA empresa; mesmo assim, toda consulta
 * filtra por company_id e o RLS do banco recusa qualquer outra. O cache local evita recarregar
 * tudo após cada operação (sem recarregar a página).
 */
const PAGE = 1000
const DEFAULT_CUSTOM: ScenarioAssumptions = { ...CONSERVATIVE_SCENARIO, id: 'custom', receivableDelayDays: 14, receivableHaircutPct: 0 }

type DbError = { code?: string; message?: string } | null

function check<T>(res: { data: T; error: DbError }): T {
  if (res.error) throw new RepositoryError(friendlyDbError(res.error))
  return res.data
}

export class SupabaseRepository implements FinanceRepository {
  readonly mode = 'supabase' as const
  private cache: CompanySnapshot | null = null
  private actorNames = new Map<string, string>()

  constructor(
    private sb: SupabaseClient,
    private companyId: string,
    private role: MemberRole,
  ) {}

  async load(): Promise<CompanySnapshot> {
    this.cache ??= await this.fetchAll()
    return structuredClone(this.cache)
  }

  private async fetchTransactions(): Promise<Transaction[]> {
    const out: Transaction[] = []
    for (let from = 0; ; from += PAGE) {
      const rows = check(
        await this.sb
          .from('transactions')
          .select(TX_COLUMNS)
          .eq('company_id', this.companyId)
          .order('id')
          .range(from, from + PAGE - 1),
      ) as unknown as TxRow[]
      out.push(...rows.map(rowToTransaction))
      if (rows.length < PAGE) return out
    }
  }

  private async fetchAudit(): Promise<AuditEntry[]> {
    const rows = check(
      await this.sb
        .from('audit_logs')
        .select('id,at,actor,action,entity,entity_id,summary')
        .eq('company_id', this.companyId)
        .order('at', { ascending: false })
        .limit(200),
    ) as { id: number; at: string; actor: string | null; action: AuditEntry['action']; entity: string; entity_id: string; summary: string }[]
    const missing = [...new Set(rows.map((r) => r.actor).filter((a): a is string => !!a && !this.actorNames.has(a)))]
    if (missing.length) {
      const profiles = check(await this.sb.from('profiles').select('id,full_name').in('id', missing)) as { id: string; full_name: string }[]
      for (const p of profiles) this.actorNames.set(p.id, p.full_name || 'Usuário')
    }
    return rows.map((r) => ({
      id: String(r.id),
      at: r.at,
      actor: r.actor ? (this.actorNames.get(r.actor) ?? 'Usuário') : 'Sistema',
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      summary: r.summary,
    }))
  }

  private async fetchAll(): Promise<CompanySnapshot> {
    const c = this.companyId
    const [company, accounts, categories, transactions, alerts, settings, imports, scenarios, audit] = await Promise.all([
      this.sb.from('companies').select('id,name,timezone,currency').eq('id', c).single(),
      this.sb.from('accounts').select('id,name,opening_balance,opening_date').eq('company_id', c).order('created_at'),
      this.sb.from('categories').select('id,name,kind,fixed').eq('company_id', c).order('name'),
      this.fetchTransactions(),
      this.sb.from('alert_states').select('fingerprint,state,note,updated_at').eq('company_id', c),
      this.sb.from('company_settings').select('alert_config,custom_scenario').eq('company_id', c).maybeSingle(),
      this.sb
        .from('imports')
        .select('id,file_name,file_hash,actor,total_rows,imported,skipped,errors,warnings,created_at')
        .eq('company_id', c)
        .order('created_at', { ascending: false })
        .limit(100),
      this.sb
        .from('scenarios')
        .select('id,name,horizon_days,decisions,as_of,result_summary,created_at')
        .eq('company_id', c)
        .order('created_at', { ascending: false })
        .limit(50),
      this.fetchAudit(),
    ])
    const co = check(company) as { id: string; name: string; timezone: string; currency: 'BRL' }
    const st = check(settings) as { alert_config: Partial<AlertConfig>; custom_scenario: Partial<ScenarioAssumptions> } | null
    return {
      company: { id: co.id, name: co.name, timezone: co.timezone, currency: co.currency, isDemo: false, role: this.role },
      accounts: (check(accounts) as { id: string; name: string; opening_balance: string; opening_date: string }[]).map((a) => ({
        id: a.id,
        name: a.name,
        openingBalance: numericToCents(a.opening_balance),
        openingDate: a.opening_date,
      })),
      categories: check(categories) as Category[],
      transactions,
      alertStatus: Object.fromEntries(
        (check(alerts) as { fingerprint: string; state: AlertState; note: string | null; updated_at: string }[]).map((a) => [
          a.fingerprint,
          { fingerprint: a.fingerprint, state: a.state, note: a.note ?? undefined, updatedAt: a.updated_at },
        ]),
      ),
      audit,
      imports: (
        check(imports) as {
          id: string
          file_name: string
          file_hash: string
          actor: string | null
          total_rows: number
          imported: number
          skipped: number
          errors: number
          warnings: number
          created_at: string
        }[]
      ).map((i) => ({
        id: i.id,
        fileName: i.file_name,
        fileHash: i.file_hash,
        at: i.created_at,
        actor: i.actor ? (this.actorNames.get(i.actor) ?? 'Usuário') : '—',
        totalRows: i.total_rows,
        imported: i.imported,
        skipped: i.skipped,
        errors: i.errors,
        warnings: i.warnings,
      })),
      scenarios: (
        check(scenarios) as {
          id: string
          name: string
          horizon_days: number
          decisions: SavedScenario['decisions']
          as_of: string
          result_summary: SavedScenario['resultSummary']
          created_at: string
        }[]
      ).map((s) => ({
        id: s.id,
        name: s.name,
        horizonDays: s.horizon_days,
        decisions: s.decisions,
        asOf: s.as_of,
        resultSummary: s.result_summary,
        createdAt: s.created_at,
      })),
      alertConfig: sanitizeConfig(st?.alert_config),
      customScenario: { ...DEFAULT_CUSTOM, ...(st?.custom_scenario ?? {}), id: 'custom' },
      anchor: todayIn(co.timezone),
    }
  }

  private async state() {
    return (this.cache ??= await this.fetchAll())
  }

  private async refreshAudit() {
    const s = await this.state()
    s.audit = await this.fetchAudit()
  }

  async createTransaction(input: ValidTransaction): Promise<Transaction> {
    const row = check(
      await this.sb
        .from('transactions')
        .insert({ ...transactionToRow(input), company_id: this.companyId })
        .select(TX_COLUMNS)
        .single(),
    ) as unknown as TxRow
    const tx = rowToTransaction(row)
    const s = await this.state()
    s.transactions = [...s.transactions, tx]
    await this.refreshAudit()
    return tx
  }

  async updateTransaction(id: string, input: ValidTransaction): Promise<Transaction> {
    const rows = check(
      await this.sb.from('transactions').update(transactionToRow(input)).eq('id', id).eq('company_id', this.companyId).select(TX_COLUMNS),
    ) as unknown as TxRow[]
    // RLS não gera erro ao bloquear um UPDATE: ele simplesmente não afeta linhas.
    if (!rows.length) throw new RepositoryError('Lançamento não encontrado ou sem permissão para editar.')
    const tx = rowToTransaction(rows[0])
    const s = await this.state()
    s.transactions = s.transactions.map((t) => (t.id === id ? tx : t))
    await this.refreshAudit()
    return tx
  }

  async deleteTransaction(id: string): Promise<void> {
    const rows = check(await this.sb.from('transactions').delete().eq('id', id).eq('company_id', this.companyId).select('id')) as { id: string }[]
    if (!rows.length) throw new RepositoryError('Lançamento não encontrado ou sem permissão para excluir.')
    const s = await this.state()
    s.transactions = s.transactions.filter((t) => t.id !== id)
    await this.refreshAudit()
  }

  async importTransactions(rows: ValidTransaction[], meta: Omit<ImportRecord, 'id' | 'at' | 'actor'>): Promise<ImportRecord> {
    const payload = rows.map((r) => ({
      kind: r.kind,
      status: r.status,
      description: r.description,
      counterparty: r.counterparty ?? null,
      category_id: r.categoryId,
      account_id: r.accountId,
      amount: centsToNumeric(r.amount),
      competence_date: r.competenceDate,
      due_date: r.dueDate,
      settled_date: r.settledDate,
      notes: r.notes ?? null,
      source_ref: r.sourceRef ?? null,
    }))
    const importId = check(
      await this.sb.rpc('import_transactions', {
        p_company: this.companyId,
        p_file_name: meta.fileName,
        p_file_hash: meta.fileHash,
        p_rows: payload,
        p_stats: { total_rows: meta.totalRows, skipped: meta.skipped, errors: meta.errors, warnings: meta.warnings },
      }),
    ) as string
    // Recarrega tudo: a importação pode trazer milhares de linhas criadas no servidor.
    this.cache = await this.fetchAll()
    const rec = this.cache.imports.find((i) => i.id === importId)
    if (!rec) throw new RepositoryError('Importação concluída, mas o registro não foi encontrado.')
    return rec
  }

  async setAlertState(fingerprint: string, state: AlertState, note?: string) {
    const row = check(
      await this.sb
        .from('alert_states')
        .upsert({ company_id: this.companyId, fingerprint, state, note: note ?? null }, { onConflict: 'company_id,fingerprint' })
        .select('fingerprint,state,note,updated_at')
        .single(),
    ) as { fingerprint: string; state: AlertState; note: string | null; updated_at: string }
    const rec = { fingerprint: row.fingerprint, state: row.state, note: row.note ?? undefined, updatedAt: row.updated_at }
    const s = await this.state()
    s.alertStatus = { ...s.alertStatus, [fingerprint]: rec }
    await this.refreshAudit()
    return rec
  }

  private async updateSettings(patch: Record<string, unknown>) {
    const rows = check(await this.sb.from('company_settings').update(patch).eq('company_id', this.companyId).select('company_id')) as unknown[]
    if (!rows.length) throw new RepositoryError('Somente proprietários e administradores podem alterar configurações.')
  }

  async saveAlertConfig(config: AlertConfig) {
    await this.updateSettings({ alert_config: config })
    const s = await this.state()
    s.alertConfig = config
    await this.refreshAudit()
  }

  async saveCustomScenario(sc: ScenarioAssumptions) {
    await this.updateSettings({ custom_scenario: sc })
    const s = await this.state()
    s.customScenario = sc
  }

  async addCategory(c: Omit<Category, 'id'>): Promise<Category> {
    const row = check(
      await this.sb
        .from('categories')
        .insert({ company_id: this.companyId, name: c.name, kind: c.kind, fixed: !!c.fixed })
        .select('id,name,kind,fixed')
        .single(),
    ) as Category
    const s = await this.state()
    s.categories = [...s.categories, row]
    await this.refreshAudit()
    return row
  }

  async updateCompanyName(name: string): Promise<Company> {
    const valid = validateCompanyName(name)
    if (!valid.ok) throw new RepositoryError(valid.error)
    // Nunca envie company_id no payload: a empresa é identificada apenas pelo filtro e pelo RLS.
    const rows = check(await this.sb.from('companies').update({ name: valid.value }).eq('id', this.companyId).select('id,name,timezone,currency')) as {
      id: string
      name: string
      timezone: string
      currency: 'BRL'
    }[]
    // RLS bloqueia UPDATE silenciosamente (0 linhas) em vez de gerar erro.
    if (!rows.length) throw new RepositoryError('Empresa não encontrada ou sem permissão para editar.')
    const row = rows[0]
    const s = await this.state()
    s.company = { ...s.company, id: row.id, name: row.name, timezone: row.timezone, currency: row.currency }
    await this.refreshAudit()
    return structuredClone(s.company)
  }

  async updateAccountOpeningBalance(accountId: string, openingBalance: Cents): Promise<Account> {
    const valid = validateOpeningBalance(openingBalance)
    if (!valid.ok) throw new RepositoryError(valid.error)
    // A conta é localizada pelo filtro; company_id jamais vai no payload de alteração.
    const rows = check(
      await this.sb
        .from('accounts')
        .update({ opening_balance: centsToNumeric(valid.value) })
        .eq('id', accountId)
        .eq('company_id', this.companyId)
        .select('id,name,opening_balance,opening_date'),
    ) as { id: string; name: string; opening_balance: string; opening_date: string }[]
    if (!rows.length) throw new RepositoryError('Conta não encontrada ou sem permissão para editar.')
    const row = rows[0]
    const account: Account = {
      id: row.id,
      name: row.name,
      openingBalance: numericToCents(row.opening_balance),
      openingDate: row.opening_date,
    }
    const s = await this.state()
    s.accounts = s.accounts.map((a) => (a.id === accountId ? account : a))
    await this.refreshAudit()
    return structuredClone(account)
  }

  async saveScenario(sc: Omit<SavedScenario, 'id' | 'createdAt'>): Promise<SavedScenario> {
    const row = check(
      await this.sb
        .from('scenarios')
        .insert({
          company_id: this.companyId,
          name: sc.name,
          horizon_days: sc.horizonDays,
          decisions: sc.decisions,
          as_of: sc.asOf,
          result_summary: sc.resultSummary,
        })
        .select('id,created_at')
        .single(),
    ) as { id: string; created_at: string }
    const saved = { ...sc, id: row.id, createdAt: row.created_at }
    const s = await this.state()
    s.scenarios = [saved, ...s.scenarios]
    return saved
  }

  async deleteScenario(id: string) {
    const rows = check(await this.sb.from('scenarios').delete().eq('id', id).eq('company_id', this.companyId).select('id')) as unknown[]
    if (!rows.length) throw new RepositoryError('Cenário não encontrado ou sem permissão.')
    const s = await this.state()
    s.scenarios = s.scenarios.filter((x) => x.id !== id)
  }

  async listMembers(): Promise<CompanyMember[]> {
    const rows = check(await this.sb.from('company_members').select('user_id,role,created_at').eq('company_id', this.companyId).order('created_at')) as {
      user_id: string
      role: MemberRole
      created_at: string
    }[]
    const ids = rows.map((r) => r.user_id)
    const names = new Map<string, string>()
    if (ids.length) {
      const profiles = check(await this.sb.from('profiles').select('id,full_name').in('id', ids)) as { id: string; full_name: string }[]
      for (const p of profiles) names.set(p.id, p.full_name || 'Usuário')
    }
    return rows.map((r) => ({ userId: r.user_id, name: names.get(r.user_id) ?? 'Usuário', role: r.role, joinedAt: r.created_at }))
  }

  async listInvites(): Promise<CompanyInvite[]> {
    const rows = check(
      await this.sb
        .from('company_invites')
        .select('id,email,role,created_at,expires_at,accepted_at,revoked_at')
        .eq('company_id', this.companyId)
        .order('created_at', { ascending: false }),
    ) as InviteRow[]
    return rows.map(rowToInvite)
  }

  async createInvite(input: CreateInviteInput): Promise<CompanyInvite> {
    const email = validateInviteEmail(input.email)
    if (!email.ok) throw new RepositoryError(email.error)
    const role = validateInviteRole(input.role)
    if (!role.ok) throw new RepositoryError(role.error)
    const created = check(await this.sb.rpc('create_invite', { p_company: this.companyId, p_email: email.value, p_role: role.value })) as {
      id: string
      token: string
    }
    const now = new Date()
    return {
      id: created.id,
      email: email.value,
      role: role.value,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      acceptedAt: null,
      revokedAt: null,
      token: created.token,
    }
  }

  async revokeInvite(id: string): Promise<void> {
    check(await this.sb.rpc('revoke_invite', { p_invite: id }))
  }

  async updateMemberRole(userId: string, role: InviteRole): Promise<CompanyMember> {
    const valid = validateInviteRole(role)
    if (!valid.ok) throw new RepositoryError(valid.error)
    // A política do banco impede tocar na linha do owner; o filtro repete a regra no cliente.
    const rows = check(
      await this.sb
        .from('company_members')
        .update({ role: valid.value })
        .eq('company_id', this.companyId)
        .eq('user_id', userId)
        .neq('role', 'owner')
        .select('user_id,role,created_at'),
    ) as { user_id: string; role: MemberRole; created_at: string }[]
    // RLS não gera erro ao bloquear: 0 linhas significa sem permissão, owner ou membro inexistente.
    if (!rows.length) throw new RepositoryError('Membro não encontrado, é o proprietário ou você não tem permissão para alterar.')
    return (
      (await this.listMembers()).find((m) => m.userId === userId) ?? {
        userId: rows[0].user_id,
        name: 'Usuário',
        role: rows[0].role,
        joinedAt: rows[0].created_at,
      }
    )
  }

  async removeMember(userId: string): Promise<void> {
    const rows = check(
      await this.sb.from('company_members').delete().eq('company_id', this.companyId).eq('user_id', userId).neq('role', 'owner').select('user_id'),
    ) as { user_id: string }[]
    if (!rows.length) throw new RepositoryError('Membro não encontrado, é o proprietário ou você não tem permissão para remover.')
  }

  async reset(): Promise<CompanySnapshot> {
    throw new RepositoryError('Reinicializar está disponível apenas no modo de demonstração.')
  }
}

interface InviteRow {
  id: string
  email: string
  role: InviteRole
  created_at: string
  expires_at: string
  accepted_at: string | null
  revoked_at: string | null
}

function rowToInvite(r: InviteRow): CompanyInvite {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    revokedAt: r.revoked_at,
  }
}

/** Configuração vinda do banco é tratada como entrada não confiável: só números válidos sobrescrevem o padrão. */
function sanitizeConfig(raw: Partial<AlertConfig> | undefined): AlertConfig {
  const out = { ...DEFAULT_ALERT_CONFIG }
  if (!raw || typeof raw !== 'object') return out
  for (const k of Object.keys(out) as (keyof AlertConfig)[]) {
    const v = raw[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
  }
  return out
}
