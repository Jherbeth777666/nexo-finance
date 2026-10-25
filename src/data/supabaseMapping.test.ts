import { centsToNumeric, friendlyDbError, numericToCents, rowToTransaction, transactionToRow, type TxRow } from './supabaseMapping'
import { suggestMapping, toTable, validateRows } from '@/domain/import/pipeline'
import { cats } from '@/domain/finance/testkit'

describe('conversão NUMERIC ↔ centavos', () => {
  it.each([
    ['1234.50', 123450],
    ['0.05', 5],
    ['-10.00', -1000],
    ['999999999999.99', 99999999999999],
    ['7', 700],
    ['7.1', 710],
  ])('%s → %i', (v, c) => {
    expect(numericToCents(v)).toBe(c)
  })
  it('aceita número vindo do driver sem erro de float', () => {
    expect(numericToCents(0.1 + 0.2)).toBe(30)
  })
  it.each([123450, 5, -1000, 0, 99999999999999])('ida e volta exata: %i', (c) => {
    expect(numericToCents(centsToNumeric(c))).toBe(c)
  })
  it('formata para NUMERIC sem float', () => {
    expect(centsToNumeric(5)).toBe('0.05')
    expect(centsToNumeric(-123456)).toBe('-1234.56')
    expect(() => centsToNumeric(1.5)).toThrow()
    expect(() => numericToCents('abc')).toThrow()
  })
})

describe('mapeamento de lançamento', () => {
  const row: TxRow = {
    id: 'x',
    company_id: 'c',
    kind: 'expense',
    status: 'settled',
    description: 'Aluguel',
    counterparty: null,
    category_id: 'k',
    account_id: 'a',
    to_account_id: null,
    amount: '4800.00',
    competence_date: '2026-03-01',
    due_date: '2026-03-05',
    settled_date: '2026-03-05',
    recurrence_id: null,
    notes: null,
    source: 'manual',
    import_id: null,
    source_ref: null,
    created_at: 't',
    updated_at: 't',
  }
  it('linha → domínio → linha preserva os campos editáveis', () => {
    const tx = rowToTransaction(row)
    expect(tx.amount).toBe(480000)
    expect(tx.counterparty).toBeUndefined()
    const back = transactionToRow(tx)
    expect(back).toMatchObject({ amount: '4800.00', category_id: 'k', settled_date: '2026-03-05', to_account_id: null })
    // company_id, autoria e origem nunca vão do cliente em edições
    expect(back).not.toHaveProperty('company_id')
    expect(back).not.toHaveProperty('source')
  })
})

describe('mensagens de erro do banco', () => {
  it('não expõem detalhes internos', () => {
    expect(friendlyDbError({ code: '42501', message: 'new row violates row-level security policy for table "transactions"' })).toMatch(/permissão/)
    expect(friendlyDbError({ code: '23514', message: 'new row for relation "transactions" violates check constraint "x"' })).toBe(
      'Os dados não passaram na validação do servidor.',
    )
    expect(friendlyDbError({ code: '23514', message: 'Data de liquidação não pode estar no futuro' })).toBe('Data de liquidação não pode estar no futuro')
    expect(friendlyDbError({ code: 'XX000', message: 'segredo interno' })).not.toMatch(/segredo/)
  })
})

describe('linhas idênticas no mesmo arquivo', () => {
  it('recebem identificadores de origem distintos e estáveis', () => {
    const t = toTable([
      ['Data', 'Descrição', 'Valor'],
      ['01/03/2026', 'Café', '-10,00'],
      ['01/03/2026', 'Café', '-10,00'],
      ['01/03/2026', 'Café', '-10,00'],
    ])
    const ctx = { categories: cats, existing: [], asOf: '2026-03-15' }
    const rows = validateRows(t, suggestMapping(t.headers), ctx)
    const refs = rows.map((r) => r.tx!.sourceRef)
    expect(new Set(refs).size).toBe(3)
    expect(refs[1]).toBe(`${refs[0]}#2`)
    expect(rows[2].warnings.join()).toMatch(/Igual à linha 2/)
    // Reimportar o mesmo conteúdo reconhece as três linhas.
    const again = validateRows(t, suggestMapping(t.headers), {
      ...ctx,
      existing: rows.map((r, i) => ({ ...r.tx!, id: `e${i}`, accountId: 'a', source: 'import' as const, createdAt: '', updatedAt: '' })),
    })
    expect(again.every((r) => r.alreadyImported)).toBe(true)
  })
})
