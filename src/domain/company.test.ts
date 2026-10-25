import { OPENING_BALANCE_MAX_ABS, validateCompanyName, validateOpeningBalance } from './company'

describe('validação do nome da empresa', () => {
  it('remove espaços e aceita os limites de 2 a 120 caracteres', () => {
    expect(validateCompanyName('  Padaria Central  ')).toEqual({ ok: true, value: 'Padaria Central' })
    expect(validateCompanyName('AB')).toEqual({ ok: true, value: 'AB' })
    expect(validateCompanyName(` ${'x'.repeat(120)} `)).toEqual({ ok: true, value: 'x'.repeat(120) })
  })

  it('rejeita nome curto, longo, vazio ou de outro tipo', () => {
    expect(validateCompanyName(' a ')).toMatchObject({ ok: false, error: expect.stringMatching(/2 a 120/) })
    expect(validateCompanyName('')).toMatchObject({ ok: false })
    expect(validateCompanyName('x'.repeat(121))).toMatchObject({ ok: false })
    expect(validateCompanyName(null)).toMatchObject({ ok: false })
    expect(validateCompanyName(42)).toMatchObject({ ok: false })
  })
})

describe('validação do saldo de abertura', () => {
  it('aceita zero, negativos e o limite absoluto', () => {
    expect(validateOpeningBalance(0)).toEqual({ ok: true, value: 0 })
    expect(validateOpeningBalance(-12345)).toEqual({ ok: true, value: -12345 })
    expect(validateOpeningBalance(OPENING_BALANCE_MAX_ABS)).toEqual({ ok: true, value: OPENING_BALANCE_MAX_ABS })
    expect(validateOpeningBalance(-OPENING_BALANCE_MAX_ABS)).toEqual({ ok: true, value: -OPENING_BALANCE_MAX_ABS })
  })

  it('rejeita frações, valores não numéricos e fora do limite', () => {
    expect(validateOpeningBalance(1.5)).toMatchObject({ ok: false })
    expect(validateOpeningBalance(Number.NaN)).toMatchObject({ ok: false })
    expect(validateOpeningBalance(Number.POSITIVE_INFINITY)).toMatchObject({ ok: false })
    expect(validateOpeningBalance(OPENING_BALANCE_MAX_ABS + 1)).toMatchObject({ ok: false })
    expect(validateOpeningBalance(OPENING_BALANCE_MAX_ABS * 100)).toMatchObject({ ok: false })
    expect(validateOpeningBalance('100')).toMatchObject({ ok: false })
  })
})
