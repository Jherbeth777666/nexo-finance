import type { Account, Category, Company, Transaction, TxKind, TxStatus } from '@/domain/types'
import { addDays, addMonths, weekday, type ISODate } from '@/lib/dates'
import type { Cents } from '@/lib/money'

/**
 * Dados sintéticos do modo de demonstração.
 * Empresa, clientes e fornecedores são FICTÍCIOS. Os valores são gerados de forma determinística
 * (semente fixa) e relativos à data de hoje, para que vencidos e futuros façam sentido sempre.
 *
 * Situações embutidas de propósito, para demonstrar as regras de alerta:
 * - Conta de energia ~60% acima da média no último mês.
 * - Três recebimentos de clientes corporativos vencidos.
 * - Semana com concentração de pagamentos (aluguel + folha + fornecedor + parcela).
 * - Um par de lançamentos de manutenção possivelmente duplicado.
 * - Dois lançamentos sem categoria.
 */

export const DEMO_COMPANY: Company = {
  id: 'demo-company',
  name: 'Empório Serra Azul (fictícia)',
  timezone: 'America/Sao_Paulo',
  currency: 'BRL',
  isDemo: true,
  role: 'owner',
}

export const DEMO_CATEGORIES: Category[] = [
  { id: 'c-vendas-cartao', name: 'Vendas no cartão', kind: 'income' },
  { id: 'c-vendas-dinheiro', name: 'Vendas em dinheiro e Pix', kind: 'income' },
  { id: 'c-vendas-corporativas', name: 'Vendas corporativas', kind: 'income' },
  { id: 'c-fornecedores', name: 'Fornecedores de mercadoria', kind: 'expense' },
  { id: 'c-folha', name: 'Folha de pagamento', kind: 'expense', fixed: true },
  { id: 'c-aluguel', name: 'Aluguel', kind: 'expense', fixed: true },
  { id: 'c-energia', name: 'Energia elétrica', kind: 'expense', fixed: true },
  { id: 'c-impostos', name: 'Impostos (DAS)', kind: 'expense' },
  { id: 'c-servicos', name: 'Serviços e assinaturas', kind: 'expense', fixed: true },
  { id: 'c-manutencao', name: 'Manutenção', kind: 'expense' },
  { id: 'c-taxas', name: 'Taxas bancárias e de cartão', kind: 'expense' },
  { id: 'c-equipamentos', name: 'Equipamentos', kind: 'expense' },
]

/** PRNG determinístico (mulberry32): mesmos dados a cada reinicialização. */
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface DemoDataset {
  company: Company
  accounts: Account[]
  categories: Category[]
  transactions: Transaction[]
  anchor: ISODate
}

export function buildDemoDataset(today: ISODate): DemoDataset {
  const rand = rng(20260101)
  const vary = (base: Cents, pct: number) => Math.round((base * (1 + (rand() * 2 - 1) * pct)) / 100) * 100
  const start = addDays(today, -182)
  const accounts: Account[] = [
    { id: 'a-corrente', name: 'Conta corrente', openingBalance: 2_150_000, openingDate: start },
    { id: 'a-caixa', name: 'Caixa da loja', openingBalance: 120_000, openingDate: start },
  ]
  const txs: Transaction[] = []
  let n = 0
  const createdAt = `${start}T09:00:00-03:00`
  const push = (p: {
    kind: TxKind
    description: string
    amount: Cents
    date: ISODate
    categoryId: string | null
    counterparty?: string
    account?: string
    due?: ISODate
    status?: TxStatus
    settled?: ISODate | null
    recurrenceId?: string
    toAccountId?: string
  }) => {
    const due = p.due ?? p.date
    const status: TxStatus = p.status ?? (due <= today ? 'settled' : 'pending')
    txs.push({
      id: `demo-${String(++n).padStart(4, '0')}`,
      kind: p.kind,
      status,
      description: p.description,
      counterparty: p.counterparty,
      categoryId: p.categoryId,
      accountId: p.account ?? 'a-corrente',
      toAccountId: p.toAccountId,
      amount: p.amount,
      competenceDate: p.date,
      dueDate: due,
      settledDate: status === 'settled' ? (p.settled === undefined ? due : p.settled) : null,
      recurrenceId: p.recurrenceId,
      source: 'demo',
      createdAt,
      updatedAt: createdAt,
    })
  }

  // ——— Receitas semanais (vendas da loja) ———
  for (let d = start; d <= addDays(today, 28); d = addDays(d, 7)) {
    const isFuture = d > today
    // Vendas no cartão de semanas passadas liquidam em D+30: as das últimas 4 semanas ainda estão a receber.
    if (!isFuture) {
      const sale = vary(1_020_000, 0.12)
      push({
        kind: 'income',
        description: 'Recebíveis de cartão — vendas da semana',
        counterparty: 'Credenciadora de cartões',
        amount: sale,
        date: d,
        due: addDays(d, 30),
        categoryId: 'c-vendas-cartao',
      })
      push({
        kind: 'income',
        description: 'Vendas em dinheiro e Pix — semana',
        amount: vary(310_000, 0.15),
        date: d,
        categoryId: 'c-vendas-dinheiro',
        account: 'a-caixa',
      })
      // Depósito do caixa na conta corrente (transferência entre contas próprias).
      push({
        kind: 'transfer',
        description: 'Depósito do caixa da loja',
        amount: 220_000,
        date: addDays(d, 1),
        categoryId: null,
        account: 'a-caixa',
        toAccountId: 'a-corrente',
        status: addDays(d, 1) <= today ? 'settled' : 'pending',
      })
    }
  }

  // ——— Vendas corporativas (prazo de 28 dias) ———
  const clients = ['Restaurante Vale Verde (fictício)', 'Hotel Pedra Alta (fictício)', 'Café Ladeira (fictício)']
  for (let i = 0; i < 13; i++) {
    const date = addDays(start, 6 + i * 14)
    if (date > today) break
    const due = addDays(date, 28)
    push({
      kind: 'income',
      description: `Fornecimento mensal — NF ${1180 + i}`,
      counterparty: clients[i % 3],
      amount: vary(380_000, 0.2),
      date,
      due,
      categoryId: 'c-vendas-corporativas',
    })
  }
  // Três recebimentos vencidos (situação a demonstrar).
  const overdue: [number, string, Cents][] = [
    [-41, clients[1], 410_000],
    [-19, clients[0], 230_000],
    [-9, clients[2], 185_000],
  ]
  overdue.forEach(([offset, client, amount], i) =>
    push({
      kind: 'income',
      description: `Fornecimento — NF ${1300 + i}`,
      counterparty: client,
      amount,
      date: addDays(today, offset - 28),
      due: addDays(today, offset),
      categoryId: 'c-vendas-corporativas',
      status: 'pending',
    }),
  )

  // ——— Despesas mensais recorrentes ———
  const months = 9 // 6 passados + ~3 futuros (recorrências materializadas)
  const firstMonth = `${start.slice(0, 7)}-01`
  for (let m = 0; m <= months; m++) {
    const monthStart = addMonths(firstMonth, m)
    const on = (day: number) => addMonths(monthStart, 0).slice(0, 8) + String(day).padStart(2, '0')
    const inRange = (d: ISODate) => d >= start && d <= addDays(today, 95)
    const items: Parameters<typeof push>[0][] = [
      { kind: 'expense', description: 'Aluguel do ponto comercial', counterparty: 'Imobiliária Monte Claro (fictícia)', amount: 480_000, date: on(5), categoryId: 'c-aluguel', recurrenceId: 'r-aluguel' },
      { kind: 'expense', description: 'Folha de pagamento', amount: 1_360_000, date: on(5), categoryId: 'c-folha', recurrenceId: 'r-folha' },
      { kind: 'expense', description: 'Impostos — DAS Simples Nacional', amount: vary(310_000, 0.1), date: on(20), categoryId: 'c-impostos', recurrenceId: 'r-das' },
      { kind: 'expense', description: 'Internet e telefonia', counterparty: 'Provedor Conecta (fictício)', amount: 21_990, date: on(10), categoryId: 'c-servicos', recurrenceId: 'r-internet' },
      { kind: 'expense', description: 'Sistema de PDV — assinatura', amount: 18_900, date: on(12), categoryId: 'c-servicos', recurrenceId: 'r-pdv' },
      { kind: 'expense', description: 'Honorários contábeis', counterparty: 'Escritório Contábil Exato (fictício)', amount: 95_000, date: on(10), categoryId: 'c-servicos', recurrenceId: 'r-contador' },
      { kind: 'expense', description: 'Taxas de cartão e tarifas', amount: vary(98_000, 0.1), date: on(28), categoryId: 'c-taxas', recurrenceId: 'r-taxas' },
    ]
    for (const it of items) if (inRange(it.date)) push(it)
  }

  // Energia: estável e, no último ciclo, ~60% acima (situação a demonstrar).
  for (let k = 5; k >= 0; k--) {
    const date = addDays(today, -k * 30 - 12)
    push({
      kind: 'expense',
      description: 'Conta de energia',
      counterparty: 'Distribuidora de energia',
      amount: k === 0 ? 228_000 : vary(142_000, 0.05),
      date,
      due: addDays(date, 8),
      categoryId: 'c-energia',
      recurrenceId: 'r-energia',
    })
  }
  push({
    kind: 'expense',
    description: 'Conta de energia',
    counterparty: 'Distribuidora de energia',
    amount: 165_000,
    date: addDays(today, 18),
    due: addDays(today, 26),
    categoryId: 'c-energia',
    recurrenceId: 'r-energia',
  })

  // ——— Fornecedores (semanal, pagamento em 14 dias) ———
  const suppliers = ['Distribuidora Horizonte (fictícia)', 'Laticínios Campo Bom (fictício)', 'Hortifruti Boa Safra (fictício)']
  for (let d = addDays(start, 2), i = 0; d <= addDays(today, 40); d = addDays(d, 7), i++) {
    push({
      kind: 'expense',
      description: `Compra de mercadorias — pedido ${4400 + i}`,
      counterparty: suppliers[i % 3],
      amount: vary(560_000, 0.15),
      date: d,
      due: addDays(d, 14),
      categoryId: 'c-fornecedores',
    })
  }

  // ——— Concentração de pagamentos: grande pedido + parcela de equipamento na semana do dia 5 ———
  const nextFifth = (() => {
    let d = today.slice(0, 8) + '05'
    if (d <= addDays(today, 3)) d = addMonths(d, 1)
    return d
  })()
  push({
    kind: 'expense',
    description: 'Pedido sazonal — estoque de fim de ano',
    counterparty: suppliers[0],
    amount: 1_240_000,
    date: addDays(nextFifth, -20),
    due: addDays(nextFifth, 2),
    categoryId: 'c-fornecedores',
  })
  push({
    kind: 'expense',
    description: 'Câmara fria — parcela 2/4',
    counterparty: 'Refrigeração Polar (fictícia)',
    amount: 690_000,
    date: addDays(nextFifth, 1),
    categoryId: 'c-equipamentos',
  })
  push({
    kind: 'expense',
    description: 'Câmara fria — parcela 1/4',
    counterparty: 'Refrigeração Polar (fictícia)',
    amount: 690_000,
    date: addDays(nextFifth, -29),
    categoryId: 'c-equipamentos',
  })

  // ——— Situações de qualidade de dados ———
  const dupDate = addDays(today, -16)
  for (const offset of [0, 2]) {
    push({
      kind: 'expense',
      description: 'Manutenção do balcão refrigerado',
      counterparty: 'Frio Certo Assistência (fictícia)',
      amount: 64_000,
      date: addDays(dupDate, offset),
      categoryId: 'c-manutencao',
    })
  }
  push({ kind: 'expense', description: 'Material de limpeza', amount: 23_850, date: addDays(today, -6), categoryId: null, account: 'a-caixa' })
  push({ kind: 'expense', description: 'Despesa sem identificação', amount: 41_000, date: addDays(today, -3), categoryId: null })

  // Uma conta a pagar vencida há 4 dias.
  push({
    kind: 'expense',
    description: 'Embalagens personalizadas',
    counterparty: 'Gráfica Ponto Firme (fictícia)',
    amount: 87_500,
    date: addDays(today, -25),
    due: addDays(today, -4),
    categoryId: 'c-fornecedores',
    status: 'pending',
  })

  // Lançamentos de fim de semana que caem no domingo são movidos para segunda (realismo, sem efeito nas regras).
  for (const t of txs) {
    if (t.kind === 'expense' && weekday(t.dueDate) === 0) {
      t.dueDate = addDays(t.dueDate, 1)
      if (t.status === 'settled') t.settledDate = t.dueDate
      if (t.status === 'settled' && t.dueDate > today) {
        t.status = 'pending'
        t.settledDate = null
      }
    }
  }

  return { company: DEMO_COMPANY, accounts, categories: DEMO_CATEGORIES, transactions: txs, anchor: today }
}
