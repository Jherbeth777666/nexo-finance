import type { Account, Category, Transaction } from '@/domain/types'

/** Construtores para testes: valores explícitos, nada aleatório. */
let seq = 0
export function tx(p: Partial<Transaction> & Pick<Transaction, 'kind' | 'amount'>): Transaction {
  seq++
  const date = p.competenceDate ?? p.dueDate ?? '2026-03-01'
  const status = p.status ?? 'settled'
  return {
    id: p.id ?? `t${seq}`,
    status,
    description: p.description ?? `Lançamento ${seq}`,
    categoryId: p.categoryId === undefined ? (p.kind === 'transfer' ? null : 'cat') : p.categoryId,
    accountId: p.accountId ?? 'acc1',
    competenceDate: date,
    dueDate: p.dueDate ?? date,
    settledDate: p.settledDate === undefined ? (status === 'settled' ? (p.dueDate ?? date) : null) : p.settledDate,
    source: 'manual',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...p,
  }
}

export const acc = (p: Partial<Account> = {}): Account => ({
  id: 'acc1',
  name: 'Conta',
  openingBalance: 100_000,
  openingDate: '2026-01-01',
  ...p,
})

export const cats: Category[] = [
  { id: 'cat', name: 'Geral', kind: 'expense' },
  { id: 'energia', name: 'Energia', kind: 'expense' },
  { id: 'vendas', name: 'Vendas', kind: 'income' },
]
