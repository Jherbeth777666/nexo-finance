import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { addDays, todayIn } from '@/lib/dates'

/**
 * Produtos, vendas por item, eventos locais e RPC de importação, exercitados pela API pública
 * (chave anon). Exige as três variáveis de .env.test.local de um projeto de TESTE; sem elas a
 * suíte é pulada. A service_role é usada apenas para criar e remover os usuários temporários.
 */
const URL = process.env.SUPABASE_TEST_URL
const ANON = process.env.SUPABASE_TEST_ANON_KEY
const SERVICE = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
const configured = !!(URL && ANON && SERVICE)

const run = Math.random().toString(36).slice(2, 8)
const password = `Teste-${run}-senha-123`
const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const today = todayIn('America/Sao_Paulo')

interface Actor {
  id: string
  sb: SupabaseClient
}

let admin: SupabaseClient
let owner: Actor
let other: Actor
let rate: Actor
let company = ''
let otherCompany = ''
let rateCompany = ''

async function makeUser(label: string): Promise<Actor> {
  const email = `nexo-produtos-${run}-${label}@example.com`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `Teste produtos ${label}` } })
  if (error) throw error
  const sb = createClient(URL!, ANON!, opts)
  const { error: signInError } = await sb.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
  return { id: data.user.id, sb }
}

async function createCompany(actor: Actor, name: string) {
  const { data, error } = await actor.sb.rpc('create_company', { p_name: name, p_opening_balance: 0 })
  if (error) throw error
  return data as string
}

const saleRow = (over: Record<string, unknown> = {}) => ({
  product_name: 'Arroz branco 5 kg',
  product_code: 'ARZ5',
  product_id: null,
  sale_date: addDays(today, -2),
  quantity: '3.000',
  revenue: '83.70',
  unit_cost: '22.50',
  stock: '8.000',
  source_ref: `teste:${run}:${Math.random().toString(36).slice(2)}`,
  ...over,
})

const importArgs = (rows: Record<string, unknown>[]) => ({
  p_company: company,
  p_file_name: 'vendas.csv',
  p_file_hash: 'a'.repeat(64),
  p_rows: rows,
  p_stats: { total_rows: rows.length, skipped: 0, errors: 0, warnings: 0 },
})

describe.skipIf(!configured)('produtos, vendas por item e eventos locais', () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, opts)
    ;[owner, other, rate] = await Promise.all([makeUser('a'), makeUser('b'), makeUser('c')])
    company = await createCompany(owner, `Produtos A ${run}`)
    otherCompany = await createCompany(other, `Produtos B ${run}`)
    rateCompany = await createCompany(rate, `Produtos rate ${run}`)
  })

  it('isola produtos e eventos entre empresas (RLS)', async () => {
    const product = await owner.sb
      .from('products')
      .insert({
        company_id: company,
        name: 'Feijão carioca 1 kg',
        code: 'FEJ1',
        unit: 'un',
        cost_price: '6.90',
        stock: '35.000',
        stock_updated_at: addDays(today, -3),
      })
      .select('id')
      .single()
    expect(product.error).toBeNull()

    const event = await owner.sb
      .from('local_events')
      .insert({ company_id: company, name: 'Festejo do padroeiro', start_date: addDays(today, 10), end_date: addDays(today, 12) })
      .select('id')
      .single()
    expect(event.error).toBeNull()

    const seenByOther = await other.sb.from('products').select('id').eq('company_id', company)
    expect(seenByOther.data).toEqual([])

    const changedByOther = await other.sb.from('products').update({ name: 'Invadido' }).eq('id', product.data!.id).select('id')
    expect(changedByOther.data).toEqual([])

    const eventByOther = await other.sb.from('local_events').select('id').eq('company_id', company)
    expect(eventByOther.data).toEqual([])

    const seenByOtherCompany = await owner.sb.from('products').select('id').eq('company_id', otherCompany)
    expect(seenByOtherCompany.data).toEqual([])
  })

  it('viewer lê, mas não escreve produtos nem eventos', async () => {
    const member = await owner.sb.from('company_members').insert({ company_id: company, user_id: other.id, role: 'viewer' })
    expect(member.error).toBeNull()
    const read = await other.sb.from('products').select('id').eq('company_id', company)
    expect(read.error).toBeNull()
    expect(read.data!.length).toBeGreaterThan(0)
    const write = await other.sb.from('products').insert({ company_id: company, name: 'Produto do viewer' })
    expect(write.error?.code).toBe('42501')
    const event = await other.sb.from('local_events').insert({ company_id: company, name: 'Evento do viewer', start_date: today })
    expect(event.error?.code).toBe('42501')
  })

  it('importa vendas por item, cria produto novo, atualiza estoque/custo e registra auditoria', async () => {
    const existing = await owner.sb
      .from('products')
      .insert({
        company_id: company,
        name: 'Arroz branco 5 kg',
        code: 'ARZ5',
        unit: 'un',
        cost_price: '22.50',
        stock: '10.000',
        stock_updated_at: addDays(today, -5),
      })
      .select('id')
      .single()
    if (existing.error) throw existing.error

    const rows = [
      saleRow(),
      saleRow({ product_name: 'Pão francês', product_code: 'PAO1', quantity: '2.500', revenue: '47.25', unit_cost: null, stock: '4.000' }),
    ]
    const result = await owner.sb.rpc('import_product_sales', importArgs(rows))
    expect(result.error).toBeNull()
    expect(typeof result.data).toBe('string')

    const products = await owner.sb.from('products').select('id,name,cost_price,stock,stock_updated_at').eq('company_id', company).order('name')
    expect(products.error).toBeNull()
    const arroz = products.data!.find((p) => p.name === 'Arroz branco 5 kg')!
    expect(Number(arroz.cost_price)).toBe(22.5)
    expect(Number(arroz.stock)).toBe(8)
    expect(arroz.stock_updated_at).toBe(addDays(today, -2))
    const pao = products.data!.find((p) => p.name === 'Pão francês')!
    expect(Number(pao.stock)).toBe(4)

    const sales = await owner.sb.from('product_sales').select('product_id,sale_date,quantity,revenue,source_ref,import_id').eq('company_id', company)
    expect(sales.error).toBeNull()
    expect(sales.data).toHaveLength(2)
    expect(Number(sales.data!.find((s) => s.product_id === arroz.id)!.quantity)).toBe(3)

    const imports = await owner.sb
      .from('imports')
      .select('imported,skipped,errors,warnings')
      .eq('id', result.data as string)
      .single()
    expect(imports.data).toMatchObject({ imported: 2, skipped: 0, errors: 0, warnings: 0 })

    const audits = await owner.sb.from('audit_logs').select('entity,action').eq('company_id', company).order('at', { ascending: false })
    expect(audits.data!.some((a) => a.entity === 'product' && a.action === 'create')).toBe(true)
    expect(audits.data!.some((a) => a.entity === 'import' && a.action === 'import')).toBe(true)
  })

  it('casa o produto por nome normalizado (acentos, caixa e espaços)', async () => {
    const name = `Açúcar refinado ${run}`
    const created = await owner.sb.from('products').insert({ company_id: company, name, code: null, unit: 'un' }).select('id').single()
    if (created.error) throw created.error
    const before = await owner.sb.from('products').select('id').eq('company_id', company)

    const sourceRef = `teste:${run}:nome-normalizado`
    const result = await owner.sb.rpc(
      'import_product_sales',
      importArgs([
        saleRow({
          product_name: `  ACUCAR   REFINADO ${run.toUpperCase()} `,
          product_code: null,
          unit_cost: null,
          stock: null,
          source_ref: sourceRef,
        }),
      ]),
    )
    expect(result.error).toBeNull()
    const after = await owner.sb.from('products').select('id').eq('company_id', company)
    expect(after.data).toHaveLength(before.data!.length)
    const sale = await owner.sb.from('product_sales').select('product_id').eq('company_id', company).eq('source_ref', sourceRef).single()
    expect(sale.data!.product_id).toBe(created.data!.id)
  })

  it('não atualiza o cadastro quando custo e estoque não mudam', async () => {
    const created = await owner.sb
      .from('products')
      .insert({
        company_id: company,
        name: `Feijão preto ${run}`,
        code: null,
        unit: 'un',
        cost_price: '8.00',
        stock: '20.000',
        stock_updated_at: addDays(today, -3),
      })
      .select('id')
      .single()
    if (created.error) throw created.error

    const before = await owner.sb.from('audit_logs').select('id').eq('company_id', company).eq('entity', 'product').eq('action', 'update')

    const result = await owner.sb.rpc(
      'import_product_sales',
      importArgs([
        saleRow({ product_name: `FEIJÃO PRETO ${run}`, product_code: null, unit_cost: null, stock: null, source_ref: `teste:${run}:sem-cadastro` }),
        saleRow({
          product_name: `Feijão preto ${run}`,
          product_code: null,
          sale_date: addDays(today, -3),
          unit_cost: '8.00',
          stock: '20.000',
          source_ref: `teste:${run}:cadastro-igual`,
        }),
      ]),
    )
    expect(result.error).toBeNull()

    const after = await owner.sb.from('audit_logs').select('id').eq('company_id', company).eq('entity', 'product').eq('action', 'update')
    expect(after.data).toHaveLength(before.data!.length)
  })

  it('restringe colunas de local_events e audita UPDATE/DELETE', async () => {
    const event = await owner.sb
      .from('local_events')
      .insert({ company_id: company, name: `Feira ${run}`, start_date: addDays(today, 5) })
      .select('id')
      .single()
    if (event.error) throw event.error

    const changeCompany = await owner.sb.from('local_events').update({ company_id: otherCompany }).eq('id', event.data!.id)
    expect(changeCompany.error?.code).toBe('42501')

    const renamed = await owner.sb
      .from('local_events')
      .update({ name: `Feira grande ${run}` })
      .eq('id', event.data!.id)
      .select('name')
      .single()
    expect(renamed.error).toBeNull()
    expect(renamed.data!.name).toBe(`Feira grande ${run}`)

    const removed = await owner.sb.from('local_events').delete().eq('id', event.data!.id)
    expect(removed.error).toBeNull()

    const audits = await owner.sb.from('audit_logs').select('action').eq('company_id', company).eq('entity', 'local_event').eq('entity_id', event.data!.id)
    expect(audits.error).toBeNull()
    expect(audits.data!.map((a) => a.action).sort()).toEqual(['create', 'delete', 'update'])
  })

  it('resume as vendas por produto na janela (paridade com o domínio)', async () => {
    const summary = await owner.sb.rpc('product_sales_summary', { p_company: company, p_from: addDays(today, -30), p_to: today })
    expect(summary.error).toBeNull()
    const sales = await owner.sb.from('product_sales').select('product_id,quantity,revenue').eq('company_id', company)
    expect(sales.error).toBeNull()
    for (const row of summary.data!) {
      const own = sales.data!.filter((s) => s.product_id === row.product_id)
      expect(Number(row.quantity)).toBeCloseTo(
        own.reduce((sum, s) => sum + Number(s.quantity), 0),
        3,
      )
      expect(Number(row.revenue)).toBeCloseTo(
        own.reduce((sum, s) => sum + Number(s.revenue), 0),
        2,
      )
      expect(row.sales_count).toBe(own.length)
    }
  })

  it('recusa a mesma origem duas vezes e mantém o lote atômico', async () => {
    const sourceRef = `teste:${run}:duplicada`
    const first = await owner.sb.rpc('import_product_sales', importArgs([saleRow({ source_ref: sourceRef })]))
    expect(first.error).toBeNull()
    const before = await owner.sb.from('product_sales').select('id').eq('company_id', company).eq('source_ref', sourceRef)
    expect(before.data).toHaveLength(1)
    const second = await owner.sb.rpc('import_product_sales', importArgs([saleRow({ source_ref: sourceRef })]))
    expect(second.error).not.toBeNull()
    const after = await owner.sb.from('product_sales').select('id').eq('company_id', company).eq('source_ref', sourceRef)
    expect(after.data).toHaveLength(1)
  })

  it('rejeita lote vazio na RPC', async () => {
    const empty = await owner.sb.rpc('import_product_sales', importArgs([]))
    expect(empty.error?.code).toBe('54000')
  })

  it('bloqueia data futura e quantidade zero na RPC', async () => {
    const future = await owner.sb.rpc('import_product_sales', importArgs([saleRow({ sale_date: addDays(today, 1) })]))
    expect(future.error?.code).toBe('22023')
    const zero = await owner.sb.rpc('import_product_sales', importArgs([saleRow({ quantity: '0' })]))
    expect(zero.error?.code).toBe('22023')
  })

  it('limita a importação de produtos a 10 chamadas por 10 minutos', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await rate.sb.rpc('rate_limit_product_import')
      expect(r.error, `chamada ${i + 1}`).toBeNull()
    }
    const blocked = await rate.sb.rpc('rate_limit_product_import')
    expect(blocked.error?.code).toBe('54000')
    expect(rateCompany).toBeTruthy()
  })

  it('não deixa o cliente chamar o limite genérico', async () => {
    const r = await owner.sb.rpc('consume_rate_limit', { p_bucket: 'import_products', p_max: 10000, p_window_seconds: 1 })
    expect(r.error).not.toBeNull()
  })
})

afterAll(async () => {
  if (!admin) return
  for (const id of [company, otherCompany, rateCompany]) if (id) await admin.from('companies').delete().eq('id', id)
  for (const id of [owner?.id, other?.id, rate?.id]) if (id) await admin.auth.admin.deleteUser(id)
})

describe.runIf(!configured)('configuração', () => {
  it('pula os testes de produtos sem SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY e SUPABASE_TEST_SERVICE_ROLE_KEY', () => {
    expect(configured).toBe(false)
  })
})
