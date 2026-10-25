import { acc, cats } from '@/domain/finance/testkit'
import { validateImportBatch } from './serverValidation'

const ctx = { accounts: [acc()], categories: cats, today: '2026-03-15' }

const row = (over: Record<string, unknown> = {}) => ({
  kind: 'expense',
  status: 'settled',
  description: ' Aluguel ',
  counterparty: ' Imobiliária ',
  categoryId: 'cat',
  accountId: 'acc1',
  amount: 480_000,
  competenceDate: '2026-03-01',
  dueDate: '2026-03-05',
  settledDate: '2026-03-05',
  notes: ' ',
  sourceRef: 'ext:1',
  ...over,
})

describe('validação pura da importação no servidor', () => {
  it('normaliza um lote válido reaproveitando o domínio e preserva a origem', () => {
    const r = validateImportBatch([row()], ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(1)
    expect(r.value[0]).toMatchObject({
      kind: 'expense',
      status: 'settled',
      description: 'Aluguel',
      counterparty: 'Imobiliária',
      categoryId: 'cat',
      accountId: 'acc1',
      amount: 480_000,
      settledDate: '2026-03-05',
      sourceRef: 'ext:1',
    })
    expect(r.value[0].notes).toBeUndefined()

    const blankSource = validateImportBatch([row({ sourceRef: '   ' })], ctx)
    expect(blankSource.ok).toBe(true)
    if (blankSource.ok) expect(blankSource.value[0].sourceRef).toBeUndefined()
  })

  it('recusa lote inválido, vazio ou acima do limite', () => {
    expect(validateImportBatch(null, ctx)).toEqual({ ok: false, errors: [{ line: 0, message: 'Lote de importação inválido.' }] })
    expect(validateImportBatch({}, ctx).ok).toBe(false)
    expect(validateImportBatch([], ctx).ok).toBe(false)

    const tooMany = Array.from({ length: 5_001 }, () => row())
    const r = validateImportBatch(tooMany, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toEqual({ line: 0, message: 'O limite por importação é 5000 linhas.' })
  })

  it('devolve erros por linha sem interromper as demais linhas', () => {
    const r = validateImportBatch([row(), row({ accountId: 'outra' }), row({ description: '' })], ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.map((e) => e.line)).toEqual([3, 4])
    expect(r.errors[0].message).toMatch(/conta/i)
    expect(r.errors[1].message).toMatch(/descrição/i)
  })

  it('recusa campos com tipo, tamanho ou domínio inválidos', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ kind: 'transfer' }, /tipo/i],
      [{ kind: 'growth' }, /tipo/i],
      [{ status: 'done' }, /situação/i],
      [{ amount: '10,00' }, /valor/i],
      [{ amount: 1.5 }, /valor/i],
      [{ amount: -1 }, /maior que zero/i],
      [{ amount: 0 }, /maior que zero/i],
      [{ competenceDate: '2026-02-30' }, /competência/i],
      [{ dueDate: 'amanhã' }, /vencimento/i],
      [{ status: 'settled', settledDate: '2026-03-16' }, /futuro/i],
      [{ categoryId: 'vendas' }, /categoria/i],
      [{ counterparty: 'x'.repeat(121) }, /120/],
      [{ sourceRef: 'x'.repeat(301) }, /300/],
      [{ notes: 'x'.repeat(501) }, /500/],
      [{ description: 'x'.repeat(201) }, /200/],
    ]
    for (const [over, expected] of cases) {
      const r = validateImportBatch([row(over)], ctx)
      expect(r.ok, JSON.stringify(over)).toBe(false)
      if (!r.ok) expect(r.errors[0].message).toMatch(expected)
    }
  })

  it('não expõe detalhes internos do banco nas mensagens', () => {
    const r = validateImportBatch([row({ accountId: 'inexistente' })], ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0].message).not.toMatch(/constraint|violates|column|relation|postgres/i)
  })
})
