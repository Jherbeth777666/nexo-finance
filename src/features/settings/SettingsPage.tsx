import { useCallback, useEffect, useState } from 'react'
import { useData, useStore } from '@/data/store'
import type { AlertConfig } from '@/domain/finance/alerts'
import type { Account, CompanyInvite, CompanyMember, InviteRole, MemberRole } from '@/domain/types'
import { accountBalances } from '@/domain/finance/metrics'
import { validateCompanyName, validateInviteEmail, validateInviteRole, validateOpeningBalance } from '@/domain/company'
import { RepositoryError } from '@/data/repository'
import { Button, Field, Input, Money, Notice, PageHeader, Panel, Select, Tag } from '@/components/ui'
import { ConfirmDialog, useToast } from '@/components/overlay'
import { formatDateBR } from '@/lib/dates'
import { formatBRL, parseMoney, type Cents } from '@/lib/money'
import { isSupabaseConfigured } from '@/lib/env'
import { useAuth } from '@/features/auth/session'

export default function SettingsPage() {
  const data = useData()
  const { today, actions } = useStore()
  const toast = useToast()
  const [confirmReset, setConfirmReset] = useState(false)
  const balances = accountBalances(data.accounts, data.transactions, today)
  const canEdit = data.company.role === 'owner' || data.company.role === 'admin'

  return (
    <>
      <PageHeader
        meta={<p className="eyebrow">Configurações</p>}
        title="Configurações"
        description="Empresa, contas, categorias, limites de alertas e integrações."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <CompanyPanel key={`${data.company.id}:${data.company.name}`} canEdit={canEdit} />

        <Panel eyebrow="Contas" title="Saldos de abertura">
          <ul className="divide-y divide-line-soft text-sm">
            {balances.map((b) => (
              <OpeningBalanceRow
                key={`${b.account.id}:${b.account.openingBalance}`}
                account={b.account}
                balance={b.balance}
                settledCount={b.settledCount}
                canEdit={canEdit}
              />
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-3">
            O saldo inicial das projeções vem destes saldos de abertura somados aos lançamentos liquidados — por isso é rastreável.
          </p>
          {!canEdit && <p className="mt-2 text-xs text-ink-3">Somente proprietários e administradores podem alterar os saldos de abertura.</p>}
        </Panel>

        <CategoriesPanel />
        <AlertConfigPanel key={JSON.stringify(data.alertConfig)} />

        <TeamPanel />

        <Panel eyebrow="Integrações" title="Serviços externos">
          <ul className="space-y-3 text-sm">
            <li className="flex items-start justify-between gap-3">
              <div>
                <p className="text-ink">Banco de dados e autenticação (Supabase)</p>
                <p className="text-xs text-ink-3">Necessário para contas de usuário, várias empresas e dados de produção.</p>
              </div>
              <Tag tone={isSupabaseConfigured() ? 'pos' : 'neutral'}>{isSupabaseConfigured() ? 'Variáveis presentes' : 'Não configurado'}</Tag>
            </li>
            <li className="flex items-start justify-between gap-3">
              <div>
                <p className="text-ink">Análises por IA</p>
                <p className="text-xs text-ink-3">
                  Executadas somente no servidor, com dados agregados e revisão automática. A chave do provedor nunca fica no navegador.
                </p>
                {!data.company.isDemo && (
                  <p className="mt-1 text-xs text-ink-3">
                    Desligada por padrão: o plano trial permite 0 análises por mês. Para ligar, configure o provedor e aumente a cota do plano no servidor.
                  </p>
                )}
              </div>
              <Tag tone={data.company.isDemo ? 'neutral' : 'warn'}>{data.company.isDemo ? 'Indisponível na demonstração' : 'Desligada por padrão'}</Tag>
            </li>
          </ul>
        </Panel>

        {data.company.isDemo && (
          <Panel eyebrow="Dados de demonstração" title="Reinicializar">
            <p className="text-sm text-ink-2">
              Gerados em {formatDateBR(data.anchor)}. Reinicializar apaga suas alterações, importações, cenários e estados de alertas neste navegador e recria
              os dados fictícios com datas relativas a hoje.
            </p>
            {data.anchor !== today && (
              <Notice tone="warn" className="mt-3">
                Os dados foram gerados em outro dia; vencimentos e alertas podem estar defasados.
              </Notice>
            )}
            <Button className="mt-4" variant="danger" icon="reset" onClick={() => setConfirmReset(true)}>
              Reinicializar dados
            </Button>
          </Panel>
        )}

        <Panel eyebrow="Registro de ações" title="Alterações recentes" className="lg:col-span-2">
          {data.audit.length === 0 ? (
            <p className="text-sm text-ink-3">Nenhuma alteração registrada.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {data.audit.slice(0, 20).map((a) => (
                <li key={a.id} className="flex gap-3">
                  <span className="num shrink-0 text-ink-3">{new Date(a.at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</span>
                  <span className="text-ink-2">{a.summary}</span>
                  <span className="ml-auto shrink-0 text-ink-3">{a.actor}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        open={confirmReset}
        danger
        title="Reinicializar dados de demonstração?"
        description="Todas as alterações feitas neste navegador serão perdidas. Esta ação não pode ser desfeita."
        confirmLabel="Reinicializar"
        onClose={() => setConfirmReset(false)}
        onConfirm={async () => {
          await actions.reset()
          toast('Dados de demonstração reinicializados')
        }}
      />
    </>
  )
}

function CompanyPanel({ canEdit }: { canEdit: boolean }) {
  const data = useData()
  const { repo, actions } = useStore()
  const auth = useAuth()
  const toast = useToast()
  const [name, setName] = useState(data.company.name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Panel eyebrow="Empresa" title={data.company.name} actions={data.company.isDemo ? <Tag tone="warn">Demonstração</Tag> : undefined}>
      <dl className="grid grid-cols-2 gap-4 text-sm">
        <Item label="Moeda" value="Real brasileiro (BRL)" />
        <Item label="Fuso horário" value={data.company.timezone} />
        <Item label="Formato de datas" value="DD/MM/AAAA" />
        <Item label="Origem dos dados" value={repo.mode === 'demo' ? 'Navegador (isolado, fictício)' : 'Supabase'} />
      </dl>
      {canEdit ? (
        <form
          className="mt-4 border-t border-line-soft pt-4"
          onSubmit={async (e) => {
            e.preventDefault()
            const valid = validateCompanyName(name)
            if (!valid.ok) return setError(valid.error)
            setBusy(true)
            setError(null)
            try {
              await actions.updateCompanyName(valid.value)
              setName(valid.value)
              // Mantém o nome no seletor do topo em sincronia com o banco.
              if (auth.status === 'signed_in') await auth.refreshMemberships()
              toast('Nome da empresa atualizado')
            } catch (err) {
              setError(err instanceof RepositoryError ? err.message : 'Não foi possível salvar o nome da empresa.')
            } finally {
              setBusy(false)
            }
          }}
        >
          <div className="max-w-sm">
            <Field label="Nome da empresa" htmlFor="company-name" error={error ?? undefined}>
              <Input id="company-name" value={name} maxLength={120} invalid={!!error} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" className="mt-3" loading={busy}>
            Salvar nome
          </Button>
        </form>
      ) : (
        <p className="mt-4 text-xs text-ink-3">Somente proprietários e administradores podem alterar os dados da empresa.</p>
      )}
    </Panel>
  )
}

function OpeningBalanceRow({ account, balance, settledCount, canEdit }: { account: Account; balance: Cents; settledCount: number; canEdit: boolean }) {
  const { actions } = useStore()
  const toast = useToast()
  const [value, setValue] = useState(centsToInput(account.openingBalance))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = `opening-${account.id}`
  const label = `Saldo de abertura de ${account.name} (R$)`

  return (
    <li className="py-2 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-ink">{account.name}</p>
          <p className="text-xs text-ink-3">
            Abertura de <span className="num">{formatBRL(account.openingBalance)}</span> em {formatDateBR(account.openingDate)} · {settledCount} lançamentos
            liquidados
          </p>
        </div>
        <Money value={balance} tone="risk-only" className="font-medium" />
      </div>
      {canEdit && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            const cents = parseMoney(value)
            if (cents === null) return setError('Valor inválido. Ex.: 1.250,50')
            const valid = validateOpeningBalance(cents)
            if (!valid.ok) return setError(valid.error)
            setBusy(true)
            setError(null)
            try {
              await actions.updateAccountOpeningBalance(account.id, valid.value)
              setValue(centsToInput(valid.value))
              toast('Saldo de abertura atualizado')
            } catch (err) {
              setError(err instanceof RepositoryError ? err.message : 'Não foi possível salvar o saldo de abertura.')
            } finally {
              setBusy(false)
            }
          }}
        >
          <div className="w-48">
            <Field label={label} htmlFor={id} error={error ?? undefined}>
              <Input id={id} className="num" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" size="sm" loading={busy} aria-label={`Salvar saldo de abertura de ${account.name}`}>
            Salvar
          </Button>
        </form>
      )}
    </li>
  )
}

function centsToInput(cents: Cents): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`
}

const ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Proprietário',
  admin: 'Administrador',
  member: 'Membro',
  viewer: 'Somente leitura',
}

type TeamConfirmation = { kind: 'revoke'; id: string; email: string } | { kind: 'remove'; userId: string; name: string }

function TeamPanel() {
  const data = useData()
  const { repo } = useStore()
  const toast = useToast()
  const canManage = data.company.role === 'owner' || data.company.role === 'admin'
  const [members, setMembers] = useState<CompanyMember[]>([])
  const [invites, setInvites] = useState<CompanyInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InviteRole>('member')
  const [formError, setFormError] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [busyMember, setBusyMember] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<TeamConfirmation | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([repo.listMembers(), repo.listInvites()])
      setMembers(m)
      setInvites(i)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : 'Não foi possível carregar a equipe.')
    } finally {
      setLoading(false)
    }
  }, [repo])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const submitInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    const validEmail = validateInviteEmail(email)
    if (!validEmail.ok) return setFormError(validEmail.error)
    const validRole = validateInviteRole(role)
    if (!validRole.ok) return setFormError(validRole.error)
    setInviting(true)
    try {
      const invite = await repo.createInvite({ email: validEmail.value, role: validRole.value })
      setInvites((prev) => [invite, ...prev])
      setEmail('')
      setLink(invite.token ? `${location.origin}/convite/${invite.token}` : null)
      toast(repo.mode === 'demo' ? 'Convite de demonstração criado' : 'Convite criado')
    } catch (err) {
      setFormError(err instanceof RepositoryError ? err.message : 'Não foi possível criar o convite.')
    } finally {
      setInviting(false)
    }
  }

  const copyLink = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      toast('Link do convite copiado')
    } catch {
      toast('Não foi possível copiar. Selecione o link e copie manualmente.', 'risk')
    }
  }

  const changeRole = async (userId: string, next: InviteRole) => {
    setBusyMember(userId)
    try {
      await repo.updateMemberRole(userId, next)
      await refresh()
      toast('Papel atualizado')
    } catch (err) {
      toast(err instanceof RepositoryError ? err.message : 'Não foi possível alterar o papel.', 'risk')
    } finally {
      setBusyMember(null)
    }
  }

  const pendingInvites = invites.filter((i) => !i.acceptedAt && !i.revokedAt)

  return (
    <Panel eyebrow="Equipe" title={`${members.length} membro(s)`} className="lg:col-span-2">
      {loading ? (
        <p className="text-sm text-ink-3">Carregando equipe…</p>
      ) : loadError ? (
        <Notice tone="risk">{loadError}</Notice>
      ) : (
        <>
          <ul className="divide-y divide-line-soft text-sm">
            {members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 py-2 first:pt-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ink">{m.name}</p>
                  <p className="truncate text-xs text-ink-3">{m.email ?? `Entrou em ${formatDateBR(m.joinedAt.slice(0, 10))}`}</p>
                </div>
                {canManage && m.role !== 'owner' ? (
                  <Select
                    aria-label={`Papel de ${m.name}`}
                    value={m.role}
                    disabled={busyMember === m.userId}
                    onChange={(e) => changeRole(m.userId, e.target.value as InviteRole)}
                    className="w-auto"
                  >
                    <option value="admin">Administrador</option>
                    <option value="member">Membro</option>
                    <option value="viewer">Somente leitura</option>
                  </Select>
                ) : (
                  <Tag tone={m.role === 'owner' ? 'accent' : 'neutral'}>{ROLE_LABELS[m.role]}</Tag>
                )}
                {canManage && m.role !== 'owner' && (
                  <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'remove', userId: m.userId, name: m.name })}>
                    Remover
                  </Button>
                )}
              </li>
            ))}
          </ul>

          {canManage ? (
            <>
              <form onSubmit={submitInvite} noValidate className="mt-4 flex flex-wrap items-end gap-2 border-t border-line-soft pt-4">
                <div className="min-w-48 flex-1">
                  <Field label="Convidar por e-mail" htmlFor="invite-email" error={formError ?? undefined}>
                    <Input
                      id="invite-email"
                      type="email"
                      value={email}
                      invalid={!!formError}
                      placeholder="pessoa@empresa.com.br"
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </Field>
                </div>
                <Select aria-label="Papel do convidado" value={role} onChange={(e) => setRole(e.target.value as InviteRole)} className="w-auto">
                  <option value="member">Membro</option>
                  <option value="admin">Administrador</option>
                  <option value="viewer">Somente leitura</option>
                </Select>
                <Button type="submit" loading={inviting}>
                  Convidar
                </Button>
              </form>

              {link && (
                <div className="mt-3 rounded-md border border-line-soft bg-surface-2 p-3">
                  <p className="text-xs text-ink-3">
                    {repo.mode === 'demo'
                      ? 'Link de demonstração: convites só funcionam de verdade com o Supabase configurado.'
                      : 'Envie este link para a pessoa convidada. Ele expira em 7 dias.'}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input aria-label="Link do convite" readOnly value={link} className="min-w-48 flex-1" />
                    <Button type="button" size="sm" onClick={copyLink}>
                      Copiar link
                    </Button>
                  </div>
                </div>
              )}

              {pendingInvites.length > 0 && (
                <div className="mt-4 border-t border-line-soft pt-3">
                  <p className="eyebrow mb-2">Convites pendentes</p>
                  <ul className="divide-y divide-line-soft text-sm">
                    {pendingInvites.map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-ink">{i.email}</p>
                          <p className="text-xs text-ink-3">{ROLE_LABELS[i.role]}</p>
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'revoke', id: i.id, email: i.email })}>
                          Revogar
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="mt-3 text-xs text-ink-3">Somente proprietários e administradores podem convidar, alterar papéis ou remover membros.</p>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirm !== null}
        danger
        title={confirm?.kind === 'revoke' ? 'Revogar convite?' : 'Remover membro?'}
        description={
          confirm?.kind === 'revoke'
            ? `O link enviado para ${confirm.email} deixará de funcionar.`
            : `A pessoa perderá o acesso a esta empresa. Os lançamentos criados por ela permanecem.`
        }
        confirmLabel={confirm?.kind === 'revoke' ? 'Revogar' : 'Remover'}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return
          if (confirm.kind === 'revoke') {
            await repo.revokeInvite(confirm.id)
            toast('Convite revogado')
          } else {
            await repo.removeMember(confirm.userId)
            toast('Membro removido')
          }
          await refresh()
        }}
      />
    </Panel>
  )
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-ink-2">{value}</dd>
    </div>
  )
}

function CategoriesPanel() {
  const data = useData()
  const { actions } = useStore()
  const toast = useToast()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'income' | 'expense'>('expense')
  const [error, setError] = useState<string | null>(null)
  const counts = new Map<string, number>()
  for (const t of data.transactions) if (t.categoryId) counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1)
  return (
    <Panel eyebrow="Categorias" title={`${data.categories.length} categorias`}>
      <div className="grid gap-4 sm:grid-cols-2">
        {(['income', 'expense'] as const).map((k) => (
          <div key={k}>
            <p className="eyebrow mb-1.5">{k === 'income' ? 'Receitas' : 'Despesas'}</p>
            <ul className="space-y-1 text-sm">
              {data.categories
                .filter((c) => c.kind === k)
                .map((c) => (
                  <li key={c.id} className="flex justify-between gap-2 text-ink-2">
                    <span className="truncate">
                      {c.name} {c.fixed && <span className="text-2xs text-ink-3">· fixa</span>}
                    </span>
                    <span className="num text-xs text-ink-3">{counts.get(c.id) ?? 0}</span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
      <form
        className="mt-4 flex flex-wrap items-end gap-2 border-t border-line-soft pt-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setError(null)
          const n = name.trim()
          if (n.length < 2 || n.length > 60) return setError('Use de 2 a 60 caracteres.')
          try {
            await actions.addCategory({ name: n, kind })
            setName('')
            toast('Categoria criada')
          } catch (err) {
            setError(err instanceof RepositoryError ? err.message : 'Não foi possível criar a categoria.')
          }
        }}
      >
        <div className="min-w-40 flex-1">
          <Field label="Nova categoria" htmlFor="cat-name" error={error ?? undefined}>
            <Input id="cat-name" value={name} maxLength={60} invalid={!!error} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Select aria-label="Tipo da categoria" value={kind} onChange={(e) => setKind(e.target.value as 'income' | 'expense')} className="w-auto">
          <option value="expense">Despesa</option>
          <option value="income">Receita</option>
        </Select>
        <Button type="submit">Adicionar</Button>
      </form>
    </Panel>
  )
}

function AlertConfigPanel() {
  const data = useData()
  const { actions } = useStore()
  const toast = useToast()
  const c = data.alertConfig
  const [form, setForm] = useState({
    expenseIncreasePct: String(c.expenseIncreasePct),
    expenseIncreaseMin: (c.expenseIncreaseMin / 100).toFixed(2).replace('.', ','),
    receiptsDropPct: String(c.receiptsDropPct),
    concentrationSharePct: String(c.concentrationSharePct),
    safetyMargin: (c.safetyMargin / 100).toFixed(2).replace('.', ','),
    duplicateWindowDays: String(c.duplicateWindowDays),
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    const int = (k: keyof typeof form, min: number, max: number) => {
      const n = Number(form[k])
      if (!Number.isInteger(n) || n < min || n > max) errs[k] = `Entre ${min} e ${max}`
      return n
    }
    const money = (k: keyof typeof form) => {
      const v = parseMoney(form[k])
      if (v === null || v < 0) errs[k] = 'Valor inválido'
      return v ?? 0
    }
    const next: AlertConfig = {
      ...c,
      expenseIncreasePct: int('expenseIncreasePct', 5, 500),
      expenseIncreaseMin: money('expenseIncreaseMin'),
      receiptsDropPct: int('receiptsDropPct', 5, 95),
      concentrationSharePct: int('concentrationSharePct', 15, 100),
      safetyMargin: money('safetyMargin'),
      duplicateWindowDays: int('duplicateWindowDays', 0, 30),
    }
    setErrors(errs)
    if (Object.keys(errs).length) return
    try {
      await actions.saveAlertConfig(next)
      toast('Limites salvos. Os alertas foram recalculados.')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não foi possível salvar.', 'risk')
    }
  }

  return (
    <Panel eyebrow="Alertas" title="Limites das regras">
      <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-2">
        <Field label="Aumento de despesa por categoria (%)" htmlFor="ac-1" error={errors.expenseIncreasePct}>
          <Input id="ac-1" className="num" inputMode="numeric" value={form.expenseIncreasePct} onChange={set('expenseIncreasePct')} />
        </Field>
        <Field label="…e diferença mínima (R$)" htmlFor="ac-2" error={errors.expenseIncreaseMin}>
          <Input id="ac-2" className="num" inputMode="decimal" value={form.expenseIncreaseMin} onChange={set('expenseIncreaseMin')} />
        </Field>
        <Field label="Queda de recebimentos (%)" htmlFor="ac-3" error={errors.receiptsDropPct}>
          <Input id="ac-3" className="num" inputMode="numeric" value={form.receiptsDropPct} onChange={set('receiptsDropPct')} />
        </Field>
        <Field label="Concentração semanal de pagamentos (%)" htmlFor="ac-4" error={errors.concentrationSharePct}>
          <Input id="ac-4" className="num" inputMode="numeric" value={form.concentrationSharePct} onChange={set('concentrationSharePct')} />
        </Field>
        <Field label="Margem de segurança de caixa (R$)" htmlFor="ac-5" error={errors.safetyMargin}>
          <Input id="ac-5" className="num" inputMode="decimal" value={form.safetyMargin} onChange={set('safetyMargin')} />
        </Field>
        <Field label="Janela de duplicatas (dias)" htmlFor="ac-6" error={errors.duplicateWindowDays}>
          <Input id="ac-6" className="num" inputMode="numeric" value={form.duplicateWindowDays} onChange={set('duplicateWindowDays')} />
        </Field>
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit">Salvar limites</Button>
        </div>
      </form>
    </Panel>
  )
}
