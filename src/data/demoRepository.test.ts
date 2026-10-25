import { DemoRepository } from './demoRepository'
import { validateTransaction, emptyInput } from '@/domain/transactions'
import { accountBalances } from '@/domain/finance/metrics'

class MemoryStorage implements Storage {
  private m = new Map<string, string>()
  get length() {
    return this.m.size
  }
  clear() {
    this.m.clear()
  }
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
}

const input = (repo: Awaited<ReturnType<DemoRepository['load']>>, over: Partial<ReturnType<typeof emptyInput>> = {}) => {
  const r = validateTransaction(
    { ...emptyInput(repo.anchor, repo.accounts[0].id), description: 'Compra teste', amount: '150,00', ...over },
    { categories: repo.categories, accounts: repo.accounts, today: repo.anchor },
  )
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.value
}

describe('repositório de demonstração', () => {
  it('cria dados fictícios marcados como demonstração e persiste entre instâncias', async () => {
    const storage = new MemoryStorage()
    const a = new DemoRepository(storage)
    const snap = await a.load()
    expect(snap.company.isDemo).toBe(true)
    await a.createTransaction(input(snap))
    const b = new DemoRepository(storage)
    expect((await b.load()).transactions.length).toBe(snap.transactions.length + 1)
  })

  it('cria, edita e exclui com registro de auditoria', async () => {
    const repo = new DemoRepository(new MemoryStorage())
    const snap = await repo.load()
    const tx = await repo.createTransaction(input(snap))
    await repo.updateTransaction(tx.id, input(snap, { amount: '200,00' }))
    await repo.deleteTransaction(tx.id)
    const after = await repo.load()
    expect(after.transactions.find((t) => t.id === tx.id)).toBeUndefined()
    expect(after.audit.map((a) => a.action)).toEqual(['delete', 'update', 'create'])
    expect(after.audit[1].summary).toMatch(/valor/)
  })

  it('load devolve cópia: mutar o resultado não altera o repositório', async () => {
    const repo = new DemoRepository(new MemoryStorage())
    const snap = await repo.load()
    snap.transactions.length = 0
    expect((await repo.load()).transactions.length).toBeGreaterThan(0)
  })

  it('reinicializar apaga alterações', async () => {
    const repo = new DemoRepository(new MemoryStorage())
    const snap = await repo.load()
    await repo.createTransaction(input(snap))
    await repo.setAlertState('x', 'resolved')
    const fresh = await repo.reset()
    expect(fresh.transactions.length).toBe(snap.transactions.length)
    expect(fresh.alertStatus).toEqual({})
  })

  it('ignora conteúdo armazenado corrompido ou que não seja de demonstração', async () => {
    const storage = new MemoryStorage()
    storage.setItem('nexo.demo.v1', '{"company":{"isDemo":false},"transactions":[]}')
    const snap = await new DemoRepository(storage).load()
    expect(snap.company.isDemo).toBe(true)
    expect(snap.transactions.length).toBeGreaterThan(0)
    storage.setItem('nexo.demo.v1', '{corrompido')
    expect((await new DemoRepository(storage).load()).company.isDemo).toBe(true)
  })

  it('funciona em memória quando o armazenamento está bloqueado', async () => {
    const repo = new DemoRepository(null)
    expect(repo.persistent).toBe(false)
    const snap = await repo.load()
    await repo.createTransaction(input(snap))
    expect((await repo.load()).transactions.length).toBe(snap.transactions.length + 1)
  })

  it('erros ao editar/excluir lançamento inexistente', async () => {
    const repo = new DemoRepository(new MemoryStorage())
    const snap = await repo.load()
    await expect(repo.updateTransaction('nao-existe', input(snap))).rejects.toThrow(/não encontrado/)
    await expect(repo.deleteTransaction('nao-existe')).rejects.toThrow(/não encontrado/)
  })

  it('categoria duplicada é rejeitada', async () => {
    const repo = new DemoRepository(new MemoryStorage())
    await repo.addCategory({ name: 'Marketing', kind: 'expense' })
    await expect(repo.addCategory({ name: ' marketing ', kind: 'expense' })).rejects.toThrow(/Já existe/)
  })

  it('renomeia a empresa, persiste e registra auditoria', async () => {
    const storage = new MemoryStorage()
    const repo = new DemoRepository(storage)
    const before = await repo.load()
    const company = await repo.updateCompanyName('  Padaria Central  ')
    expect(company.name).toBe('Padaria Central')
    const after = await new DemoRepository(storage).load()
    expect(after.company.name).toBe('Padaria Central')
    expect(after.audit[0]).toMatchObject({ action: 'update', entity: 'company', entityId: before.company.id })
    expect(after.audit[0].summary).toMatch(/Padaria Central/)
  })

  it('rejeita nome de empresa inválido', async () => {
    const repo = new DemoRepository(new MemoryStorage())
    await expect(repo.updateCompanyName(' a ')).rejects.toThrow(/2 a 120/)
    await expect(repo.updateCompanyName('x'.repeat(121))).rejects.toThrow(/2 a 120/)
  })

  it('altera o saldo de abertura, persiste, audita e recalcula o saldo da conta', async () => {
    const storage = new MemoryStorage()
    const repo = new DemoRepository(storage)
    const snap = await repo.load()
    const account = snap.accounts[0]
    const before = accountBalances(snap.accounts, snap.transactions, snap.anchor).find((b) => b.account.id === account.id)!
    const updated = await repo.updateAccountOpeningBalance(account.id, 0)
    expect(updated.openingBalance).toBe(0)
    const after = await new DemoRepository(storage).load()
    expect(after.accounts.find((a) => a.id === account.id)?.openingBalance).toBe(0)
    const balance = accountBalances(after.accounts, after.transactions, after.anchor).find((b) => b.account.id === account.id)!
    expect(balance.balance).toBe(before.balance - account.openingBalance)
    expect(after.audit[0]).toMatchObject({ action: 'update', entity: 'account', entityId: account.id })
  })

  it('aceita saldo de abertura zero e negativo, mas rejeita conta inexistente e valor inválido', async () => {
    const repo = new DemoRepository(new MemoryStorage())
    const snap = await repo.load()
    await expect(repo.updateAccountOpeningBalance(snap.accounts[0].id, -5000)).resolves.toMatchObject({ openingBalance: -5000 })
    await expect(repo.updateAccountOpeningBalance('nao-existe', 100)).rejects.toThrow(/não encontrada/)
    await expect(repo.updateAccountOpeningBalance(snap.accounts[0].id, 1.5)).rejects.toThrow(/inválido/)
  })
})

describe('validação de lançamentos', () => {
  const ctx = {
    categories: [
      { id: 'r', name: 'Vendas', kind: 'income' as const },
      { id: 'd', name: 'Aluguel', kind: 'expense' as const },
    ],
    accounts: [
      { id: 'a', name: 'A', openingBalance: 0, openingDate: '2026-01-01' },
      { id: 'b', name: 'B', openingBalance: 0, openingDate: '2026-01-01' },
    ],
    today: '2026-03-15',
  }
  const base = { ...emptyInput('2026-03-15', 'a'), description: 'x', amount: '10' }
  const errs = (o: Partial<typeof base>) => {
    const r = validateTransaction({ ...base, ...o }, ctx)
    return r.ok ? {} : r.errors
  }
  it('exige descrição e valor positivo', () => {
    expect(errs({ description: '  ' }).description).toBeTruthy()
    expect(errs({ amount: '0' }).amount).toBeTruthy()
    expect(errs({ amount: '-5' }).amount).toBeTruthy()
    expect(errs({ amount: 'dez' }).amount).toBeTruthy()
  })
  it('liquidação exige data e não pode ser futura', () => {
    expect(errs({ status: 'settled', settledDate: '' }).settledDate).toBeTruthy()
    expect(errs({ status: 'settled', settledDate: '2026-04-01' }).settledDate).toMatch(/futuro/)
    expect(errs({ status: 'settled', settledDate: '2026-03-10' })).toEqual({})
  })
  it('categoria precisa corresponder ao tipo', () => {
    expect(errs({ kind: 'expense', categoryId: 'r' }).categoryId).toBeTruthy()
    expect(errs({ kind: 'income', categoryId: 'r' })).toEqual({})
  })
  it('transferência exige contas diferentes e não recebe categoria', () => {
    expect(errs({ kind: 'transfer', toAccountId: 'a' }).toAccountId).toBeTruthy()
    const r = validateTransaction({ ...base, kind: 'transfer', toAccountId: 'b', categoryId: 'd' }, ctx)
    expect(r.ok && r.value.categoryId).toBeNull()
  })
  it('datas inválidas', () => {
    expect(errs({ dueDate: '2026-02-30' }).dueDate).toBeTruthy()
  })
})
