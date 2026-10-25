import type { Account, Category, Transaction, TxKind, TxStatus } from './types'
import { parseMoney } from '@/lib/money'
import { isISODate, type ISODate } from '@/lib/dates'

/**
 * Validação de lançamentos — a mesma regra deve ser repetida no servidor (Fase 3: constraints
 * e funções no PostgreSQL). Nunca confiar apenas nesta camada.
 */
export interface TransactionInput {
  kind: TxKind
  status: TxStatus
  description: string
  counterparty: string
  categoryId: string
  accountId: string
  toAccountId: string
  amount: string
  competenceDate: string
  dueDate: string
  settledDate: string
  notes: string
}

export type TransactionErrors = Partial<Record<keyof TransactionInput, string>>

export function emptyInput(today: ISODate, accountId: string): TransactionInput {
  return {
    kind: 'expense',
    status: 'pending',
    description: '',
    counterparty: '',
    categoryId: '',
    accountId,
    toAccountId: '',
    amount: '',
    competenceDate: today,
    dueDate: today,
    settledDate: '',
    notes: '',
  }
}

export function inputFromTransaction(tx: Transaction): TransactionInput {
  return {
    kind: tx.kind,
    status: tx.status,
    description: tx.description,
    counterparty: tx.counterparty ?? '',
    categoryId: tx.categoryId ?? '',
    accountId: tx.accountId,
    toAccountId: tx.toAccountId ?? '',
    amount: (tx.amount / 100).toFixed(2).replace('.', ','),
    competenceDate: tx.competenceDate,
    dueDate: tx.dueDate,
    settledDate: tx.settledDate ?? '',
    notes: tx.notes ?? '',
  }
}

export type ValidTransaction = Omit<Transaction, 'id' | 'createdAt' | 'updatedAt' | 'source'>

export function validateTransaction(
  input: TransactionInput,
  ctx: { categories: Category[]; accounts: Account[]; today: ISODate },
): { ok: true; value: ValidTransaction } | { ok: false; errors: TransactionErrors } {
  const errors: TransactionErrors = {}
  const description = input.description.trim()
  if (!description) errors.description = 'Informe uma descrição'
  else if (description.length > 200) errors.description = 'Máximo de 200 caracteres'

  const amount = parseMoney(input.amount)
  if (amount === null) errors.amount = 'Valor inválido. Ex.: 1.250,50'
  else if (amount <= 0) errors.amount = 'O valor deve ser maior que zero'
  else if (amount > 99_999_999_999) errors.amount = 'Valor acima do limite permitido'

  if (!['income', 'expense', 'transfer'].includes(input.kind)) errors.kind = 'Tipo inválido'
  if (!['pending', 'settled', 'cancelled'].includes(input.status)) errors.status = 'Situação inválida'

  if (!ctx.accounts.some((a) => a.id === input.accountId)) errors.accountId = 'Selecione uma conta'
  if (input.kind === 'transfer') {
    if (!ctx.accounts.some((a) => a.id === input.toAccountId)) errors.toAccountId = 'Selecione a conta de destino'
    else if (input.toAccountId === input.accountId) errors.toAccountId = 'Origem e destino devem ser diferentes'
  } else if (input.categoryId) {
    const cat = ctx.categories.find((c) => c.id === input.categoryId)
    if (!cat) errors.categoryId = 'Categoria inexistente'
    else if (cat.kind !== input.kind) errors.categoryId = 'Categoria não corresponde ao tipo'
  }

  if (!isISODate(input.competenceDate)) errors.competenceDate = 'Data inválida'
  if (!isISODate(input.dueDate)) errors.dueDate = 'Data inválida'
  if (input.status === 'settled') {
    if (!isISODate(input.settledDate)) errors.settledDate = 'Informe a data de liquidação'
    else if (input.settledDate > ctx.today) errors.settledDate = 'Liquidação não pode estar no futuro'
  } else if (input.settledDate && !isISODate(input.settledDate)) errors.settledDate = 'Data inválida'

  if (input.notes.length > 500) errors.notes = 'Máximo de 500 caracteres'
  if (Object.keys(errors).length) return { ok: false, errors }

  return {
    ok: true,
    value: {
      kind: input.kind,
      status: input.status,
      description,
      counterparty: input.counterparty.trim() || undefined,
      categoryId: input.kind === 'transfer' ? null : input.categoryId || null,
      accountId: input.accountId,
      toAccountId: input.kind === 'transfer' ? input.toAccountId : undefined,
      amount: amount!,
      competenceDate: input.competenceDate,
      dueDate: input.dueDate,
      settledDate: input.status === 'settled' ? input.settledDate : null,
      notes: input.notes.trim() || undefined,
    },
  }
}

/** Visões nomeadas: usadas pelo dashboard (links) e pela tela de movimentações (filtros). Fonte única. */
export type TxView = 'all' | 'receivables' | 'payables' | 'overdue_receivables' | 'overdue_payables' | 'cash_in_month' | 'cash_out_month'

export const TX_VIEW_LABELS: Record<TxView, string> = {
  all: 'Todos os lançamentos',
  receivables: 'Contas a receber',
  payables: 'Contas a pagar',
  overdue_receivables: 'Recebimentos vencidos',
  overdue_payables: 'Pagamentos vencidos',
  cash_in_month: 'Recebido no mês',
  cash_out_month: 'Pago no mês',
}

export function viewPredicate(view: TxView, today: ISODate): (t: Transaction) => boolean {
  const month = today.slice(0, 7)
  switch (view) {
    case 'receivables':
      return (t) => t.kind === 'income' && t.status === 'pending'
    case 'payables':
      return (t) => t.kind === 'expense' && t.status === 'pending'
    case 'overdue_receivables':
      return (t) => t.kind === 'income' && t.status === 'pending' && t.dueDate < today
    case 'overdue_payables':
      return (t) => t.kind === 'expense' && t.status === 'pending' && t.dueDate < today
    case 'cash_in_month':
      return (t) => t.kind === 'income' && t.status === 'settled' && !!t.settledDate && t.settledDate.startsWith(month) && t.settledDate <= today
    case 'cash_out_month':
      return (t) => t.kind === 'expense' && t.status === 'settled' && !!t.settledDate && t.settledDate.startsWith(month) && t.settledDate <= today
    default:
      return () => true
  }
}

export const KIND_LABEL: Record<TxKind, string> = { income: 'Receita', expense: 'Despesa', transfer: 'Transferência' }

export function statusLabel(t: Pick<Transaction, 'kind' | 'status' | 'dueDate'>, today: ISODate): string {
  if (t.status === 'cancelled') return 'Cancelado'
  if (t.status === 'settled') return t.kind === 'income' ? 'Recebido' : t.kind === 'expense' ? 'Pago' : 'Efetivada'
  if (t.dueDate < today) return 'Vencido'
  return t.kind === 'income' ? 'A receber' : t.kind === 'expense' ? 'A pagar' : 'Agendada'
}
