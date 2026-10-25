import { INVITE_EMAIL_MAX, OPENING_BALANCE_MAX_ABS, validateCompanyName, validateInviteEmail, validateInviteRole, validateOpeningBalance } from './company'

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

describe('validação de convite', () => {
  it('normaliza espaços e maiúsculas do e-mail', () => {
    expect(validateInviteEmail('  Ana.Silva@Exemplo.COM.BR ')).toEqual({ ok: true, value: 'ana.silva@exemplo.com.br' })
    expect(validateInviteEmail('a@b.co')).toEqual({ ok: true, value: 'a@b.co' })
  })

  it('rejeita e-mail vazio, malformado, longo ou de outro tipo', () => {
    expect(validateInviteEmail('')).toMatchObject({ ok: false, error: expect.stringMatching(/válido/) })
    expect(validateInviteEmail('sem-arroba')).toMatchObject({ ok: false })
    expect(validateInviteEmail('a@b')).toMatchObject({ ok: false })
    expect(validateInviteEmail('a b@c.com')).toMatchObject({ ok: false })
    expect(validateInviteEmail(`${'x'.repeat(INVITE_EMAIL_MAX)}@exemplo.com`)).toMatchObject({ ok: false })
    expect(validateInviteEmail(null)).toMatchObject({ ok: false })
    expect(validateInviteEmail(42)).toMatchObject({ ok: false })
  })

  it('aceita somente admin, member ou viewer', () => {
    expect(validateInviteRole('admin')).toEqual({ ok: true, value: 'admin' })
    expect(validateInviteRole('member')).toEqual({ ok: true, value: 'member' })
    expect(validateInviteRole('viewer')).toEqual({ ok: true, value: 'viewer' })
    expect(validateInviteRole('owner')).toMatchObject({ ok: false, error: expect.stringMatching(/Papel inválido/) })
    expect(validateInviteRole('dono')).toMatchObject({ ok: false })
    expect(validateInviteRole(null)).toMatchObject({ ok: false })
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
