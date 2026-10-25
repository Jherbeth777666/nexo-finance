import { applyPercent, formatBRL, parseMoney, percentChange, sumCents } from './money'
import { addMonths, diffDays, excelSerialToISO, isISODate, parseDateFlexible, todayIn } from './dates'

describe('parseMoney', () => {
  it.each([
    ['1.250,50', 125050],
    ['1250,50', 125050],
    ['1250.50', 125050],
    ['1,250.50', 125050],
    ['R$ 1.250,50', 125050],
    ['R$ -1.250,50', -125050],
    ['-R$ 10', -1000],
    ['(1.250,50)', -125050],
    ['1.250', 125000],
    ['1.250.000', 125000000],
    ['0.5', 50],
    ['10,5', 1050],
    ['  99  ', 9900],
    ['150-', -15000],
    [1250.5, 125050],
  ])('%s → %i centavos', (input, expected) => {
    expect(parseMoney(input)).toBe(expected)
  })

  it.each(['', 'abc', '1,2,3,4', '12.34.5', '1.250,505', 'R$', '--10', '1 2', NaN, null, undefined])(
    'rejeita %s',
    (input) => {
      expect(parseMoney(input as never)).toBeNull()
    },
  )
})

describe('aritmética em centavos', () => {
  it('soma sem erro de ponto flutuante', () => {
    expect(sumCents([10, 20])).toBe(30)
    expect(sumCents(Array(10).fill(10))).toBe(100) // 0,10 × 10 = 1,00 exato
  })
  it('percentual com arredondamento meio-para-par', () => {
    expect(applyPercent(1000, 10)).toBe(100)
    expect(applyPercent(5, 50)).toBe(2) // 2,5 → 2
    expect(applyPercent(15, 50)).toBe(8) // 7,5 → 8
  })
  it('variação percentual sem base retorna null', () => {
    expect(percentChange(100, 0)).toBeNull()
    expect(percentChange(150, 100)).toBe(50)
  })
  it('formata em BRL', () => {
    expect(formatBRL(125050).replace(/\s/g, ' ')).toBe('R$ 1.250,50')
  })
  it('rejeita valores não inteiros na soma', () => {
    expect(() => sumCents([0.1, 0.2])).toThrow()
  })
})

describe('datas', () => {
  it.each([
    ['05/01/2026', '2026-01-05'],
    ['5/1/2026', '2026-01-05'],
    ['05-01-2026', '2026-01-05'],
    ['05.01.26', '2026-01-05'],
    ['2026-01-05', '2026-01-05'],
    ['2026/01/05', '2026-01-05'],
    ['2026-01-05T10:00:00', '2026-01-05'],
    ['29/02/2028', '2028-02-29'],
  ])('%s → %s', (input, expected) => {
    expect(parseDateFlexible(input)).toBe(expected)
  })
  it.each(['31/02/2026', '13/25/2026', '2026-13-01', 'ontem', '', '29/02/2026'])('rejeita %s', (input) => {
    expect(parseDateFlexible(input)).toBeNull()
  })
  it('converte serial do Excel', () => {
    expect(excelSerialToISO(46027)).toBe('2026-01-05')
    expect(parseDateFlexible(46027)).toBe('2026-01-05')
    expect(excelSerialToISO(1250)).toBeNull() // pequeno demais: provavelmente é um valor, não uma data
  })
  it('soma meses preservando fim de mês', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15')
  })
  it('diferença de dias ignora horário de verão/fuso', () => {
    expect(diffDays('2026-03-01', '2026-02-01')).toBe(28)
  })
  it('hoje no fuso de São Paulo', () => {
    // 02:00 UTC de 05/01 ainda é 04/01 em São Paulo (UTC−3)
    expect(todayIn('America/Sao_Paulo', new Date('2026-01-05T02:00:00Z'))).toBe('2026-01-04')
    expect(isISODate('2026-01-04')).toBe(true)
  })
})
