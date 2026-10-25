import type { Product, ProductSale } from '@/domain/types'
import { addDays } from '@/lib/dates'
import { toTable } from '@/domain/import/pipeline'
import { formatQuantity, milliToNumeric, numericToMilli, parseQuantity, revenueFor } from './quantity'
import { productKey, productSourceRef, suggestProductMapping, summarizeProductSales, validateProductSaleRows } from './mapping'
import {
  analyzeSeasonality,
  estimateStock,
  leastSoldProducts,
  productStats,
  rankProducts,
  replenishmentSuggestions,
  resolveUnitCost,
  roundSuggestedQuantity,
  staleProducts,
} from './analytics'
import { calendarEvents, easterSunday, fixedEvents, upcomingEvents } from './calendar'
import { generateOpportunities } from './opportunities'

const product = (over: Partial<Product> & Pick<Product, 'id' | 'name'>): Product => ({
  unit: 'un',
  code: null,
  costPrice: null,
  stock: null,
  stockUpdatedAt: null,
  minStock: null,
  leadTimeDays: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

const sale = (over: Partial<ProductSale> & Pick<ProductSale, 'id' | 'productId' | 'saleDate' | 'quantity' | 'revenue'>): ProductSale => ({
  unitCost: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
})

const arroz = product({
  id: 'p-arroz',
  name: 'Arroz 5 kg',
  code: 'ARZ',
  unit: 'un',
  costPrice: 2000,
  stock: 10000,
  stockUpdatedAt: '2026-03-20',
  minStock: 2000,
  leadTimeDays: 15,
})
const feijao = product({ id: 'p-feijao', name: 'Feijão 1 kg', costPrice: null })
const carvao = product({ id: 'p-carvao', name: 'Carvão 3 kg', unit: 'kg' })

const asOf = '2026-03-31'
const sales: ProductSale[] = [
  sale({ id: 's1', productId: arroz.id, saleDate: '2026-02-10', quantity: 8000, revenue: 24000 }),
  sale({ id: 's2', productId: arroz.id, saleDate: '2026-03-20', quantity: 10000, revenue: 30000 }),
  sale({ id: 's3', productId: arroz.id, saleDate: '2026-03-25', quantity: 5000, revenue: 15000 }),
  sale({ id: 's4', productId: feijao.id, saleDate: '2026-02-25', quantity: 12000, revenue: 18000 }),
  sale({ id: 's5', productId: carvao.id, saleDate: '2026-02-20', quantity: 10000, revenue: 20000 }),
  sale({ id: 's6', productId: carvao.id, saleDate: '2026-03-15', quantity: 2000, revenue: 4000, unitCost: 800 }),
]

describe('conversões de quantidade', () => {
  it('interpreta formatos brasileiros e internacionais em milésimos', () => {
    expect(parseQuantity('1,250')).toBe(1250)
    expect(parseQuantity('1.25')).toBe(1250)
    expect(parseQuantity('2')).toBe(2000)
    expect(parseQuantity('1.234,500')).toBe(1234500)
    expect(parseQuantity('1,250 kg')).toBe(1250)
    expect(parseQuantity('900 ml')).toBe(900000)
    expect(parseQuantity(1.25)).toBe(1250)
    expect(parseQuantity('-1,5')).toBe(-1500)
  })

  it('rejeita valores ambíguos em vez de adivinhar', () => {
    expect(parseQuantity('')).toBeNull()
    expect(parseQuantity('abc')).toBeNull()
    expect(parseQuantity('1,2345')).toBeNull()
    expect(parseQuantity(null)).toBeNull()
  })

  it('converte NUMERIC(14,3) sem float e volta exato', () => {
    expect(numericToMilli('1.250')).toBe(1250)
    expect(numericToMilli('0.001')).toBe(1)
    expect(numericToMilli(1.25)).toBe(1250)
    expect(milliToNumeric(1250)).toBe('1.250')
    expect(milliToNumeric(-1)).toBe('-0.001')
    for (const v of [0, 1, 999, 1250, 1234567]) expect(numericToMilli(milliToNumeric(v))).toBe(v)
    expect(() => numericToMilli('abc')).toThrow()
    expect(() => milliToNumeric(1.5)).toThrow()
  })

  it('formata quantidades com até 3 casas, sem zeros inúteis', () => {
    expect(formatQuantity(1250, 'kg')).toBe('1,25 kg')
    expect(formatQuantity(1000)).toBe('1')
    expect(formatQuantity(1)).toBe('0,001')
    expect(formatQuantity(0, 'un')).toBe('0 un')
  })

  it('calcula receita a partir de milésimos sem perder centavos', () => {
    expect(revenueFor(1250, 1000)).toBe(1250)
    expect(revenueFor(333, 1000)).toBe(333)
    expect(revenueFor(1, 1)).toBe(0)
  })
})

describe('mapeamento de planilha de vendas por item', () => {
  const table = toTable([
    ['Data', 'Produto', 'Código', 'Quantidade', 'Valor total', 'Valor unitário', 'Custo unitário', 'Estoque', 'Situação'],
    ['20/03/2026', 'Arroz 5 kg', 'ARZ', '1,250', '31,25', '25,00', '20,00', '10', ''],
    ['21/03/2026', 'Arroz 5 kg', 'ARZ', '2', '', '15,00', '', '', ''],
    ['22/03/2026', 'Produto novo', '', '1', '10,00', '', '', '', ''],
    ['23/03/2026', 'Arroz 5 kg', 'ARZ', '1', '10,00', '', '', '', 'Devolução'],
    ['24/03/2026', 'Arroz 5 kg', 'ARZ', '-1', '10,00', '', '', '', ''],
    ['25/03/2026', 'Arroz 5 kg', 'ARZ', '1', '10,00', '', '', '', ''],
    ['25/03/2026', 'Arroz 5 kg', 'ARZ', '1', '10,00', '', '', '', ''],
  ])
  const mapping = suggestProductMapping(table.headers)
  const rows = validateProductSaleRows(table, mapping, { products: [arroz], existing: [], asOf: '2026-03-31' })

  it('sugere as colunas do PDV por sinônimos', () => {
    expect(mapping).toMatchObject({ date: 0, product: 1, code: 2, quantity: 3, total: 4, unitPrice: 5, unitCost: 6, stock: 7, status: 8 })
  })

  it('lê quantidade fracionada, total e atualizações de estoque/custo', () => {
    expect(rows[0].sale).toMatchObject({
      productId: arroz.id,
      saleDate: '2026-03-20',
      quantity: 1250,
      revenue: 3125,
      unitCost: 2000,
      stock: 10000,
    })
    expect(rows[0].errors).toEqual([])
  })

  it('usa valor unitário × quantidade quando não há total', () => {
    expect(rows[1].sale).toMatchObject({ quantity: 2000, revenue: 3000 })
  })

  it('avisa sobre produto novo sem bloquear', () => {
    expect(rows[2].sale?.productId).toBeNull()
    expect(rows[2].warnings.join()).toMatch(/Produto novo/)
  })

  it('desmarca devoluções e quantidades não positivas com aviso', () => {
    expect(rows[3].include).toBe(false)
    expect(rows[3].warnings.join()).toMatch(/cancelamento ignorado/i)
    expect(rows[4].include).toBe(false)
    expect(rows[4].warnings.join()).toMatch(/zero ou negativa/)
  })

  it('reconhece linhas repetidas no arquivo e já importadas', () => {
    expect(rows[6].warnings.join()).toMatch(/Igual à linha 7/)
    const existing = [{ sourceRef: rows[0].sale!.sourceRef }]
    const again = validateProductSaleRows(table, mapping, { products: [arroz], existing, asOf: '2026-03-31' })
    expect(again[0].alreadyImported).toBe(true)
    expect(again[0].include).toBe(false)
    expect(summarizeProductSales(rows)).toMatchObject({ total: 7, valid: 5, withErrors: 0, withWarnings: 4 })
  })

  it('sinaliza divergência entre total e unitário usando o total', () => {
    const t = toTable([
      ['Data', 'Produto', 'Qtd', 'Total', 'Unitário'],
      ['20/03/2026', 'Arroz', '2', '40,00', '10,00'],
    ])
    const r = validateProductSaleRows(t, suggestProductMapping(t.headers), { products: [arroz], existing: [], asOf })
    expect(r[0].sale?.revenue).toBe(4000)
    expect(r[0].warnings.join()).toMatch(/difere/)
  })

  it('exige data, produto e quantidade válidos', () => {
    const t = toTable([
      ['Data', 'Produto', 'Quantidade', 'Valor'],
      ['31/02/2026', '', 'abc', '10'],
    ])
    const r = validateProductSaleRows(t, suggestProductMapping(t.headers), { products: [], existing: [], asOf })
    expect(r[0].errors.join()).toMatch(/Data inválida/)
    expect(r[0].errors.join()).toMatch(/Produto vazio/)
    expect(r[0].errors.join()).toMatch(/Quantidade inválida/)
  })

  it('normaliza nome e código para casar produtos', () => {
    expect(productKey('  Açúcar   Refinado ')).toBe('acucar refinado')
    expect(productSourceRef({ productCode: 'AB-1', productName: 'x', saleDate: '2026-03-20', quantity: 1000, revenue: 500 })).toBe(
      'sale:code:ab 1|2026-03-20|1000|500',
    )
    expect(productSourceRef({ productCode: null, productName: 'Açúcar', saleDate: '2026-03-20', quantity: 1000, revenue: 500, externalId: 'NF 42' })).toBe(
      'sale:name:acucar|ext:nf 42|2026-03-20|1000|500',
    )
  })

  it('desmarca devolução com quantidade não positiva mesmo sem valor total', () => {
    const t = toTable([
      ['Data', 'Produto', 'Quantidade', 'Valor unitário', 'Situação'],
      ['23/03/2026', 'Arroz 5 kg', '-1', '15,00', ''],
      ['23/03/2026', 'Arroz 5 kg', '1', '15,00', 'Devolução'],
    ])
    const r = validateProductSaleRows(t, suggestProductMapping(t.headers), { products: [arroz], existing: [], asOf })
    expect(r[0].errors).toEqual([])
    expect(r[0].include).toBe(false)
    expect(r[0].warnings.join()).toMatch(/zero ou negativa/)
    expect(r[1].errors).toEqual([])
    expect(r[1].include).toBe(false)
    expect(r[1].warnings.join()).toMatch(/cancelamento ignorado/)
  })

  it('valida nome mínimo de 2 e código máximo de 40 como o banco', () => {
    const t = toTable([
      ['Data', 'Produto', 'Código', 'Quantidade', 'Valor total'],
      ['20/03/2026', 'A', 'X'.repeat(41), '1', '10,00'],
    ])
    const r = validateProductSaleRows(t, suggestProductMapping(t.headers), { products: [], existing: [], asOf })
    expect(r[0].errors.join()).toMatch(/ao menos 2/)
    expect(r[0].errors.join()).toMatch(/acima de 40/)
  })

  it('casa pelo nome quando o código informado não existe no catálogo', () => {
    const t = toTable([
      ['Data', 'Produto', 'Código', 'Quantidade', 'Valor total'],
      ['20/03/2026', 'ARROZ 5 KG', 'CODIGO-NOVO', '1', '10,00'],
    ])
    const r = validateProductSaleRows(t, suggestProductMapping(t.headers), { products: [arroz], existing: [], asOf })
    expect(r[0].sale?.productId).toBe(arroz.id)
  })

  it('inclui o identificador de origem na chave e separa vendas iguais no mesmo dia', () => {
    const t = toTable([
      ['Data', 'Produto', 'Código', 'Quantidade', 'Valor total', 'Identificador de origem'],
      ['20/03/2026', 'Arroz 5 kg', 'ARZ', '1', '10,00', 'CUPOM-1'],
      ['20/03/2026', 'Arroz 5 kg', 'ARZ', '1', '10,00', 'CUPOM-2'],
    ])
    const r = validateProductSaleRows(t, suggestProductMapping(t.headers), { products: [arroz], existing: [], asOf })
    expect(r[0].sale!.sourceRef).not.toBe(r[1].sale!.sourceRef)
    expect(r[1].warnings.join()).not.toMatch(/Igual à linha/)
    expect(r[0].sale!.sourceRef).toContain('ext:cupom 1')
  })
})

describe('análises de produtos', () => {
  it('ranqueia mais vendidos por receita e quantidade', () => {
    expect(rankProducts([arroz, feijao, carvao], sales, asOf)[0].product.id).toBe(arroz.id)
    expect(rankProducts([arroz, feijao, carvao], sales, asOf, 30, 'quantity')[0].product.id).toBe(arroz.id)
    expect(leastSoldProducts([arroz, feijao, carvao], sales, asOf, 90)[0].product.id).toBe(feijao.id)
  })

  it('calcula margem com custo do cadastro e com média das vendas', () => {
    const stats = productStats([arroz, carvao], sales, '2026-03-02', asOf)
    expect(stats.find((s) => s.product.id === arroz.id)).toMatchObject({ revenue: 45000, margin: 15000 })
    expect(stats.find((s) => s.product.id === arroz.id)!.marginPct).toBeCloseTo(33.33, 1)
    expect(resolveUnitCost(carvao, sales)).toBe(800)
    expect(productStats([feijao], sales, '2026-02-01', asOf)[0].margin).toBeNull()
  })

  it('encontra produtos parados e quedas fortes com evidência', () => {
    const stale = staleProducts([arroz, feijao, carvao], sales, asOf)
    expect(stale.find((s) => s.product.id === feijao.id)).toMatchObject({ reason: 'no_recent_sales', recentQuantity: 0, previousQuantity: 12000, dropPct: 100 })
    expect(stale.find((s) => s.product.id === carvao.id)!.dropPct).toBeCloseTo(80, 5)
  })

  it('detecta produto parado há mais de 42 dias e prioriza parados totais', () => {
    const paradoHaMuitoTempo = product({ id: 'p-parado', name: "Farinha d'água" })
    const vendas = [
      sale({ id: 'old1', productId: paradoHaMuitoTempo.id, saleDate: '2026-01-15', quantity: 5000, revenue: 10000 }),
      sale({ id: 'old2', productId: paradoHaMuitoTempo.id, saleDate: '2026-01-20', quantity: 5000, revenue: 10000 }),
      ...sales.filter((s) => s.productId === carvao.id),
    ]
    const stale = staleProducts([paradoHaMuitoTempo, carvao], vendas, asOf)
    const parado = stale.find((s) => s.product.id === paradoHaMuitoTempo.id)!
    expect(parado).toMatchObject({ reason: 'no_recent_sales', dropPct: 100, recentQuantity: 0, previousQuantity: 0 })
    expect(parado.daysWithoutSale).toBeGreaterThan(42)
    expect(stale[0].product.id).toBe(paradoHaMuitoTempo.id)
    expect(stale[1].product.id).toBe(carvao.id)
  })

  it('estima estoque descontando apenas vendas posteriores à contagem', () => {
    const estate = estimateStock(arroz, sales, asOf)
    expect(estate).toMatchObject({ estimated: 5000, soldSinceCount: 5000, outdated: false })
    const outdated = estimateStock(product({ id: arroz.id, name: 'X', stock: 1000, stockUpdatedAt: '2026-03-01' }), sales, asOf)
    expect(outdated.estimated).toBe(0)
    expect(outdated.outdated).toBe(true)
    expect(estimateStock(product({ id: 'y', name: 'Y' }), sales, asOf).estimated).toBeNull()
  })

  it('sugere reposição comparando cobertura com o prazo do fornecedor', () => {
    const [first] = replenishmentSuggestions([arroz], sales, asOf).filter((s) => s.product.id === arroz.id)
    expect(first).toMatchObject({ needsReorder: true, coverageDays: 10, status: 'reorder' })
    expect(first.suggestedQuantity).toBe(3000)
  })

  it('arredonda a sugestão para cima conforme a unidade', () => {
    expect(roundSuggestedQuantity(18134, 'un')).toBe(19000)
    expect(roundSuggestedQuantity(18134, 'cx')).toBe(19000)
    expect(roundSuggestedQuantity(18134, 'kg')).toBe(18200)
    expect(roundSuggestedQuantity(18101, 'l')).toBe(18200)
    expect(roundSuggestedQuantity(1001, ' ML ')).toBe(1100)
    expect(roundSuggestedQuantity(0, 'un')).toBe(0)
    expect(roundSuggestedQuantity(-50, 'kg')).toBe(0)

    const unidade = product({ id: 'p-refri', name: 'Refrigerante', unit: 'un', stock: 0, stockUpdatedAt: asOf, leadTimeDays: 7 })
    const peso = product({ id: 'p-carne', name: 'Carne', unit: 'kg', stock: 1000, stockUpdatedAt: asOf, leadTimeDays: 7 })
    const list = replenishmentSuggestions(
      [unidade, peso],
      [
        sale({ id: 'u1', productId: unidade.id, saleDate: asOf, quantity: 10000, revenue: 5000 }),
        sale({ id: 'k1', productId: peso.id, saleDate: asOf, quantity: 20000, revenue: 10000 }),
      ],
      asOf,
    )
    expect(list.find((s) => s.product.id === unidade.id)!.suggestedQuantity).toBe(3000)
    expect(list.find((s) => s.product.id === peso.id)!.suggestedQuantity).toBe(3700)
  })

  it('não inventa sazonalidade com histórico curto', () => {
    const short = analyzeSeasonality(
      sales.filter((s) => s.saleDate >= '2026-03-22'),
      asOf,
    )
    expect(short.sufficient).toBe(false)
  })

  it('mede início do mês e junho com histórico suficiente', () => {
    const end = '2026-07-15'
    const generated: ProductSale[] = []
    for (let i = 0; i < 90; i++) {
      const date = addDays(end, -i)
      const day = Number(date.slice(8, 10))
      const month = Number(date.slice(5, 7))
      const quantity = (day <= 10 ? 2000 : 1000) * (month === 6 ? 2 : 1)
      generated.push(sale({ id: `g${i}`, productId: arroz.id, saleDate: date, quantity, revenue: quantity * 2 }))
    }
    const season = analyzeSeasonality(generated, end)
    expect(season.sufficient).toBe(true)
    expect(season.firstTenAvg).toBeGreaterThan(season.restAvg)
    expect(season.byMonth.find((b) => b.key === '06')!.index).toBeGreaterThan(1)
  })

  it('calcula sazonalidade em faturamento por dia, não em quantidade', () => {
    const season = analyzeSeasonality(
      [
        sale({ id: 'sa1', productId: arroz.id, saleDate: '2026-03-01', quantity: 1000, revenue: 5000 }),
        sale({ id: 'sa2', productId: carvao.id, saleDate: '2026-03-02', quantity: 10000, revenue: 10000 }),
      ],
      '2026-03-02',
    )
    expect(season.historyDays).toBe(2)
    expect(season.overallAvg).toBe(7500)
    expect(season.firstTenAvg).toBe(7500)
    expect(season.restAvg).toBe(0)
    expect(season.byMonth[0].avgDaily).toBe(7500)
    expect(season.byWeekday.find((w) => w.key === '0')!.avgDaily).toBe(5000)
    expect(season.byWeekday.find((w) => w.key === '1')!.avgDaily).toBe(10000)
  })
})

describe('calendário', () => {
  it('calcula a Páscoa e as datas móveis', () => {
    expect(easterSunday(2026)).toBe('2026-04-05')
    const events = fixedEvents(2026)
    expect(events.find((e) => e.name === 'Carnaval')!.startDate).toBe('2026-02-17')
    expect(events.find((e) => e.name === 'Dia das Mães')!.startDate).toBe('2026-05-10')
    expect(events.find((e) => e.name === 'Black Friday')!.startDate).toBe('2026-11-27')
    expect(events.find((e) => e.name === 'Natal')!.startDate).toBe('2026-12-25')
    expect(events.filter((e) => e.name === 'Início do mês (contas e salários)')).toHaveLength(12)
  })

  it('funde eventos locais e não inventa festas da cidade', () => {
    const local = [{ id: 'l1', name: 'Festejo do padroeiro', startDate: '2026-06-10', endDate: '2026-06-12', kind: 'local' as const, createdAt: '2026-01-01' }]
    const events = calendarEvents('2026-06-01', '2026-06-30', local)
    expect(events.some((e) => e.name === 'Festejo do padroeiro' && e.source === 'local')).toBe(true)
    expect(events.some((e) => e.name === 'São João (junho no Maranhão)' && e.source === 'fixed')).toBe(true)
    expect(events.every((e) => !/itapecuru/i.test(e.name))).toBe(true)
  })

  it('lista próximos eventos ordenados', () => {
    const list = upcomingEvents('2026-06-01', 40)
    expect(list[0].startDate).toBe('2026-06-01')
    expect(list.map((e) => e.startDate)).toEqual([...list.map((e) => e.startDate)].sort())
  })
})

describe('oportunidades', () => {
  it('cita números e usa linguagem de sugestão, sem certeza', () => {
    const end = '2026-07-15'
    const generated: ProductSale[] = []
    for (let i = 0; i < 90; i++) {
      const date = addDays(end, -i)
      const day = Number(date.slice(8, 10))
      const month = Number(date.slice(5, 7))
      const quantity = (day <= 10 ? 2000 : 1000) * (month === 6 ? 2 : 1)
      generated.push(sale({ id: `g${i}`, productId: arroz.id, saleDate: date, quantity, revenue: quantity * 2 }))
    }
    const staleSales = [
      ...generated,
      sale({ id: 'f1', productId: feijao.id, saleDate: '2026-05-20', quantity: 12000, revenue: 18000 }),
      sale({ id: 'f2', productId: feijao.id, saleDate: '2026-06-10', quantity: 10000, revenue: 15000 }),
    ]
    const leite = product({ id: 'p-leite', name: 'Leite', stock: 5000, stockUpdatedAt: end, minStock: 1000, leadTimeDays: 30 })
    staleSales.push(sale({ id: 'l1', productId: leite.id, saleDate: addDays(end, -2), quantity: 30000, revenue: 30000 }))
    const list = generateOpportunities({ products: [arroz, feijao, carvao, leite], sales: staleSales, asOf: end })
    expect(list.length).toBeGreaterThan(0)
    expect(list.some((o) => o.kind === 'stale')).toBe(true)
    expect(list.some((o) => o.kind === 'restock')).toBe(true)
    expect(list.some((o) => o.kind === 'month_start')).toBe(true)
    for (const o of list) {
      expect(o.description).toMatch(/\d/)
      expect(o.evidence.length).toBeGreaterThan(0)
      expect(o.description).not.toMatch(/com certeza|vai vender|garantido/i)
    }
  })

  it('não gera sugestões de sazonalidade sem histórico suficiente', () => {
    const list = generateOpportunities({ products: [arroz], sales: sales.filter((s) => s.saleDate >= '2026-03-25'), asOf })
    expect(list.some((o) => o.kind === 'month_start' || o.kind === 'seasonality')).toBe(false)
  })

  it('descreve sazonalidade em R$ por dia de faturamento', () => {
    const end = '2026-07-15'
    const generated: ProductSale[] = []
    for (let i = 0; i < 90; i++) {
      const date = addDays(end, -i)
      const day = Number(date.slice(8, 10))
      const month = Number(date.slice(5, 7))
      const quantity = (day <= 10 ? 2000 : 1000) * (month === 6 ? 2 : 1)
      generated.push(sale({ id: `g${i}`, productId: arroz.id, saleDate: date, quantity, revenue: quantity * 2 }))
    }
    const list = generateOpportunities({ products: [arroz], sales: generated, asOf: end })
    const monthStart = list.find((o) => o.kind === 'month_start')!
    const june = list.find((o) => o.kind === 'seasonality')!
    expect(monthStart.description).toMatch(/faturamento/i)
    expect(monthStart.description).toMatch(/R\$/)
    expect(june.description).toMatch(/faturamento/i)
    expect(monthStart.evidence.find((e) => /Dias 1 a 10/.test(e.label))!.value).toMatch(/R\$/)
    expect(june.evidence.find((e) => /Junho/.test(e.label))!.value).toMatch(/R\$/)

    // O percentual do texto bate com os dois valores exibidos (dias 1 a 10 × demais dias).
    const money = (label: RegExp) =>
      Number(
        monthStart.evidence
          .find((e) => label.test(e.label))!
          .value.replace(/[^\d,]/g, '')
          .replace(',', '.'),
      )
    const expected = Math.round((money(/Dias 1 a 10/) / money(/Demais dias/) - 1) * 100)
    expect(monthStart.description).toContain(`${expected}%`)
  })

  it('menos vendidos seguem o faturamento, não a quantidade (que mistura unidades)', () => {
    const bala = product({ id: 'p-bala', name: 'Bala avulsa' })
    const gas = product({ id: 'p-gas', name: 'Gás 13 kg' })
    const mixed: ProductSale[] = [
      sale({ id: 'b1', productId: bala.id, saleDate: asOf, quantity: 500_000, revenue: 5000 }),
      sale({ id: 'g1', productId: gas.id, saleDate: asOf, quantity: 2000, revenue: 22000 }),
    ]
    expect(leastSoldProducts([gas, bala], mixed, asOf, 90).map((s) => s.product.id)).toEqual([bala.id, gas.id])
  })
})
