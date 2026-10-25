import { DemoRepository } from './demoRepository'
import { validateTransaction, emptyInput } from '@/domain/transactions'

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
