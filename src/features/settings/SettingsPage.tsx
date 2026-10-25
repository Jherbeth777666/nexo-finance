import { useState } from 'react'
import { useData, useStore } from '@/data/store'
import type { AlertConfig } from '@/domain/finance/alerts'
import { accountBalances } from '@/domain/finance/metrics'
import { RepositoryError } from '@/data/repository'
import { Button, Field, Input, Money, Notice, PageHeader, Panel, Select, Tag } from '@/components/ui'
import { ConfirmDialog, useToast } from '@/components/overlay'
import { formatDateBR } from '@/lib/dates'
import { formatBRL, parseMoney } from '@/lib/money'
import { isSupabaseConfigured } from '@/lib/env'

export default function SettingsPage() {
  const data = useData()
  const { today, actions, repo } = useStore()
  const toast = useToast()
  const [confirmReset, setConfirmReset] = useState(false)
  const balances = accountBalances(data.accounts, data.transactions, today)

  return (
    <>
      <PageHeader meta={<p className="eyebrow">Configurações</p>} title="Configurações" description="Empresa, contas, categorias, limites de alertas e integrações." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel eyebrow="Empresa" title={data.company.name} actions={data.company.isDemo ? <Tag tone="warn">Demonstração</Tag> : undefined}>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <Item label="Moeda" value="Real brasileiro (BRL)" />
            <Item label="Fuso horário" value={data.company.timezone} />
            <Item label="Formato de datas" value="DD/MM/AAAA" />
            <Item label="Origem dos dados" value={repo.mode === 'demo' ? 'Navegador (isolado, fictício)' : 'Supabase'} />
          </dl>
          {data.company.isDemo && <p className="mt-4 text-xs text-ink-3">Edição dos dados da empresa e convite de usuários ficam disponíveis com a autenticação (Fase 3).</p>}
        </Panel>

        <Panel eyebrow="Contas" title="Saldos de abertura">
          <ul className="divide-y divide-line-soft text-sm">
            {balances.map((b) => (
              <li key={b.account.id} className="flex items-baseline justify-between gap-3 py-2 first:pt-0">
                <div>
                  <p className="text-ink">{b.account.name}</p>
                  <p className="text-xs text-ink-3">
                    Abertura de <span className="num">{formatBRL(b.account.openingBalance)}</span> em {formatDateBR(b.account.openingDate)} · {b.settledCount} lançamentos liquidados
                  </p>
                </div>
                <Money value={b.balance} tone="risk-only" className="font-medium" />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-3">O saldo inicial das projeções vem destes saldos de abertura somados aos lançamentos liquidados — por isso é rastreável.</p>
        </Panel>

        <CategoriesPanel />
        <AlertConfigPanel key={JSON.stringify(data.alertConfig)} />

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
                <p className="text-xs text-ink-3">Executadas somente no servidor. A chave nunca fica no navegador.</p>
              </div>
              <Tag>Não configurado</Tag>
            </li>
          </ul>
        </Panel>

        {data.company.isDemo && (
          <Panel eyebrow="Dados de demonstração" title="Reinicializar">
            <p className="text-sm text-ink-2">
              Gerados em {formatDateBR(data.anchor)}. Reinicializar apaga suas alterações, importações, cenários e estados de alertas neste navegador e recria os dados fictícios com datas
              relativas a hoje.
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
