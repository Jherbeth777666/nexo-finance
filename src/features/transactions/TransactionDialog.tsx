import { useEffect, useState } from 'react'
import type { Transaction } from '@/domain/types'
import { emptyInput, inputFromTransaction, validateTransaction, type TransactionErrors, type TransactionInput } from '@/domain/transactions'
import { useData, useStore } from '@/data/store'
import { ConfirmDialog, Dialog, useToast } from '@/components/overlay'
import { Button, Field, Input, Select, Tag } from '@/components/ui'
import { formatDateBR } from '@/lib/dates'

export function TransactionDialog({ open, tx, onClose }: { open: boolean; tx: Transaction | null; onClose: () => void }) {
  const data = useData()
  const { today, actions } = useStore()
  const toast = useToast()
  const [form, setForm] = useState<TransactionInput>(() => emptyInput(today, data.accounts[0]?.id ?? ''))
  const [errors, setErrors] = useState<TransactionErrors>({})
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(tx ? inputFromTransaction(tx) : emptyInput(today, data.accounts[0]?.id ?? ''))
    setErrors({})
  }, [open, tx, today, data.accounts])

  const set = <K extends keyof TransactionInput>(k: K, v: TransactionInput[K]) => {
    setForm((f) => {
      const next = { ...f, [k]: v }
      // Ao marcar como liquidado, sugere a data de hoje (editável).
      if (k === 'status' && v === 'settled' && !f.settledDate) next.settledDate = f.dueDate <= today ? f.dueDate : today
      if (k === 'kind') next.categoryId = ''
      return next
    })
    setErrors((e) => ({ ...e, [k]: undefined }))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const r = validateTransaction(form, { categories: data.categories, accounts: data.accounts, today })
    if (!r.ok) {
      setErrors(r.errors)
      const first = Object.keys(r.errors)[0]
      document.getElementById(`tx-${first}`)?.focus()
      return
    }
    setSaving(true)
    try {
      if (tx) await actions.updateTransaction(tx.id, r.value)
      else await actions.createTransaction(r.value)
      toast(tx ? 'Lançamento atualizado' : 'Lançamento criado')
      onClose()
    } catch {
      toast('Não foi possível salvar. Tente novamente.', 'risk')
    } finally {
      setSaving(false)
    }
  }

  const cats = data.categories.filter((c) => c.kind === form.kind)
  const history = tx ? data.audit.filter((a) => a.entityId === tx.id) : []

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={tx ? 'Editar lançamento' : 'Novo lançamento'}
        description={tx?.source === 'demo' ? 'Lançamento fictício da demonstração.' : tx?.source === 'import' ? 'Lançamento importado de planilha.' : undefined}
        size="lg"
        footer={
          <>
            {tx && (
              <Button variant="ghost" icon="trash" className="mr-auto text-risk hover:text-risk" onClick={() => setConfirmDelete(true)}>
                Excluir
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" type="submit" form="tx-form" loading={saving}>
              {tx ? 'Salvar alterações' : 'Criar lançamento'}
            </Button>
          </>
        }
      >
        <form id="tx-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
          <Field label="Tipo" htmlFor="tx-kind" error={errors.kind}>
            <Select id="tx-kind" value={form.kind} onChange={(e) => set('kind', e.target.value as TransactionInput['kind'])}>
              <option value="expense">Despesa</option>
              <option value="income">Receita</option>
              <option value="transfer">Transferência entre contas próprias</option>
            </Select>
          </Field>
          <Field label="Situação" htmlFor="tx-status" error={errors.status}>
            <Select id="tx-status" value={form.status} onChange={(e) => set('status', e.target.value as TransactionInput['status'])}>
              <option value="pending">{form.kind === 'income' ? 'A receber' : form.kind === 'expense' ? 'A pagar' : 'Agendada'}</option>
              <option value="settled">{form.kind === 'income' ? 'Recebido' : form.kind === 'expense' ? 'Pago' : 'Efetivada'}</option>
              <option value="cancelled">Cancelado</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Descrição" htmlFor="tx-description" error={errors.description}>
              <Input
                id="tx-description"
                value={form.description}
                maxLength={200}
                invalid={!!errors.description}
                onChange={(e) => set('description', e.target.value)}
                autoFocus
              />
            </Field>
          </div>
          <Field label="Valor (R$)" htmlFor="tx-amount" error={errors.amount} hint="Ex.: 1.250,50">
            <Input
              id="tx-amount"
              inputMode="decimal"
              className="num"
              value={form.amount}
              invalid={!!errors.amount}
              onChange={(e) => set('amount', e.target.value)}
            />
          </Field>
          {form.kind === 'transfer' ? (
            <Field label="Conta de destino" htmlFor="tx-toAccountId" error={errors.toAccountId}>
              <Select id="tx-toAccountId" value={form.toAccountId} invalid={!!errors.toAccountId} onChange={(e) => set('toAccountId', e.target.value)}>
                <option value="">Selecione</option>
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Categoria" htmlFor="tx-categoryId" error={errors.categoryId}>
              <Select id="tx-categoryId" value={form.categoryId} invalid={!!errors.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">Sem categoria</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={form.kind === 'transfer' ? 'Conta de origem' : 'Conta'} htmlFor="tx-accountId" error={errors.accountId}>
            <Select id="tx-accountId" value={form.accountId} invalid={!!errors.accountId} onChange={(e) => set('accountId', e.target.value)}>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          {form.kind !== 'transfer' && (
            <Field label={form.kind === 'income' ? 'Cliente' : 'Fornecedor'} htmlFor="tx-counterparty">
              <Input id="tx-counterparty" value={form.counterparty} maxLength={120} onChange={(e) => set('counterparty', e.target.value)} />
            </Field>
          )}
          <Field label="Competência" htmlFor="tx-competenceDate" error={errors.competenceDate} hint="Período a que o fato pertence">
            <Input
              id="tx-competenceDate"
              type="date"
              value={form.competenceDate}
              invalid={!!errors.competenceDate}
              onChange={(e) => set('competenceDate', e.target.value)}
            />
          </Field>
          <Field label="Vencimento" htmlFor="tx-dueDate" error={errors.dueDate}>
            <Input id="tx-dueDate" type="date" value={form.dueDate} invalid={!!errors.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
          </Field>
          {form.status === 'settled' && (
            <Field label={form.kind === 'income' ? 'Recebido em' : 'Pago em'} htmlFor="tx-settledDate" error={errors.settledDate}>
              <Input
                id="tx-settledDate"
                type="date"
                max={today}
                value={form.settledDate}
                invalid={!!errors.settledDate}
                onChange={(e) => set('settledDate', e.target.value)}
              />
            </Field>
          )}
          <div className="sm:col-span-2">
            <Field label="Observações" htmlFor="tx-notes" error={errors.notes}>
              <textarea id="tx-notes" className="field min-h-16" maxLength={500} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>
          {form.kind === 'transfer' && (
            <p className="text-xs text-ink-3 sm:col-span-2">
              Transferências entre contas próprias alteram o saldo de cada conta, mas não contam como receita, despesa ou resultado.
            </p>
          )}
        </form>

        {tx && (
          <section className="mt-6 border-t border-line-soft pt-4">
            <h3 className="eyebrow mb-2">Histórico</h3>
            <ul className="space-y-1.5 text-xs text-ink-2">
              {history.map((h) => (
                <li key={h.id} className="flex gap-2">
                  <span className="num shrink-0 text-ink-3">{new Date(h.at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</span>
                  <span>
                    {h.summary} · {h.actor}
                  </span>
                </li>
              ))}
              <li className="flex flex-wrap items-center gap-2 text-ink-3">
                Origem: <Tag>{tx.source === 'demo' ? 'dados de demonstração' : tx.source === 'import' ? 'importação' : 'manual'}</Tag>
                {tx.recurrenceId && <Tag tone="accent">recorrente</Tag>}
                {tx.source !== 'demo' && <span className="num">criado em {formatDateBR(tx.createdAt.slice(0, 10))}</span>}
              </li>
            </ul>
          </section>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        danger
        title="Excluir lançamento?"
        description={`"${tx?.description}" será removido e deixará de compor saldos, projeções e relatórios. A exclusão fica registrada no histórico.`}
        confirmLabel="Excluir"
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (!tx) return
          await actions.deleteTransaction(tx.id)
          toast('Lançamento excluído')
          onClose()
        }}
      />
    </>
  )
}
