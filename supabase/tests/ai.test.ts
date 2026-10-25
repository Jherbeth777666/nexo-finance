import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { todayIn } from '@/lib/dates'

/**
 * Fase 5 no banco: RLS de ai_analyses (membro lê, ninguém escreve pelo cliente), cota mensal,
 * limite por usuário e totais por categoria sem dados individuais. Roda só com as três
 * variáveis de .env.test.local (projeto de TESTE); sem elas, é pulada como as demais suítes.
 */
const URL = process.env.SUPABASE_TEST_URL
const ANON = process.env.SUPABASE_TEST_ANON_KEY
const SERVICE = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
const configured = !!(URL && ANON && SERVICE)

const run = Math.random().toString(36).slice(2, 8)
const password = `Teste-${run}-senha-123`
const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const today = todayIn('America/Sao_Paulo')
const quotaPlan = `test_ai_${run}`

let admin: SupabaseClient
let owner: SupabaseClient
let outsider: SupabaseClient
let viewer: SupabaseClient
let viewerId = ''
let userId = ''
let outsiderId = ''
let company = ''
let otherCompany = ''
let account = ''
let analysisId = ''

async function makeUser(label: string) {
  const email = `nexo-ia-${run}-${label}@example.com`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `Teste IA ${label}` } })
  if (error) throw error
  const sb = createClient(URL!, ANON!, opts)
  const { error: signInError } = await sb.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
  return { id: data.user.id, sb }
}

const analysisRow = (over: Record<string, unknown> = {}) => ({
  company_id: company,
  agent: 'cash',
  input_hash: 'a'.repeat(64),
  provider: 'fake',
  duration_ms: 10,
  status: 'ok',
  ...over,
})

describe.skipIf(!configured)('análises de IA: RLS, cota, limite e totais por categoria', () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, opts)
    const a = await makeUser('owner')
    const b = await makeUser('outsider')
    userId = a.id
    outsiderId = b.id
    owner = a.sb
    outsider = b.sb

    const created = await owner.rpc('create_company', { p_name: `IA ${run}`, p_opening_balance: 100 })
    if (created.error) throw created.error
    company = created.data as string

    const other = await outsider.rpc('create_company', { p_name: `IA outra ${run}` })
    if (other.error) throw other.error
    otherCompany = other.data as string

    const v = await makeUser('viewer')
    viewerId = v.id
    viewer = v.sb
    const asViewer = await admin.from('company_members').insert({ company_id: company, user_id: v.id, role: 'viewer' })
    if (asViewer.error) throw asViewer.error

    const accountRow = await owner.from('accounts').select('id').eq('company_id', company).limit(1).single()
    if (accountRow.error) throw accountRow.error
    account = accountRow.data.id as string

    const plan = await admin
      .from('plan_limits')
      .insert({ plan: quotaPlan, max_members: 3, max_import_rows: 5000, max_companies_per_user: 3, ai_monthly_analyses: 2 })
    if (plan.error) throw plan.error

    const inserted = await admin.from('ai_analyses').insert(analysisRow()).select('id').single()
    if (inserted.error) throw inserted.error
    analysisId = inserted.data.id as string
  })

  it('membro lê; quem não é membro não vê nada', async () => {
    const own = await owner.from('ai_analyses').select('id,status').eq('company_id', company)
    expect(own.error).toBeNull()
    expect(own.data).toEqual([{ id: analysisId, status: 'ok' }])

    const other = await outsider.from('ai_analyses').select('id').eq('company_id', company)
    expect(other.data).toEqual([])
    expect(
      await outsider
        .from('ai_analyses')
        .select('id')
        .eq('company_id', otherCompany)
        .then((r) => r.data),
    ).toEqual([])
  })

  it('o cliente não escreve em ai_analyses (INSERT, UPDATE e DELETE negados)', async () => {
    const insert = await owner
      .from('ai_analyses')
      .insert(analysisRow({ input_hash: 'b'.repeat(64) }))
      .select('id')
    expect(insert.error).not.toBeNull()

    const update = await owner.from('ai_analyses').update({ status: 'error' }).eq('id', analysisId).select('id')
    expect(update.error).not.toBeNull()

    const del = await owner.from('ai_analyses').delete().eq('id', analysisId).select('id')
    expect(del.error).not.toBeNull()

    const check = await admin.from('ai_analyses').select('status').eq('id', analysisId).single()
    expect(check.data?.status).toBe('ok')
  })

  it('cota do trial (0) bloqueia; cota positiva reserva vaga de forma atômica', async () => {
    const args = { p_company: company, p_agent: 'cash', p_input_hash: 'd'.repeat(64) }
    const trial = await owner.rpc('ai_quota_reserve', args)
    expect(trial.error?.code).toBe('54000')

    const setPlan = await admin.from('companies').update({ plan: quotaPlan }).eq('id', company)
    if (setPlan.error) throw setPlan.error

    // Já existe 1 registro; o limite é 2: a reserva passa e ocupa a segunda vaga como pendente.
    const reserved = await owner.rpc('ai_quota_reserve', args)
    expect(reserved.error).toBeNull()
    const row = await admin
      .from('ai_analyses')
      .select('status')
      .eq('id', reserved.data as string)
      .single()
    expect(row.data?.status).toBe('pending')

    expect((await owner.rpc('ai_quota_reserve', args)).error?.code).toBe('54000')
  })

  it('viewer não reserva cota (gerar análise custa)', async () => {
    const r = await viewer.rpc('ai_quota_reserve', { p_company: company, p_agent: 'cash', p_input_hash: 'f'.repeat(64) })
    expect(r.error?.code).toBe('42501')
  })

  it('não membro não reserva cota de outra empresa', async () => {
    const r = await outsider.rpc('ai_quota_reserve', { p_company: company, p_agent: 'cash', p_input_hash: 'e'.repeat(64) })
    expect(r.error?.code).toBe('42501')
  })

  it('limite do agente: 10 chamadas a cada 10 minutos por usuário', async () => {
    for (let i = 0; i < 10; i++) expect((await owner.rpc('rate_limit_ai')).error, `chamada ${i + 1}`).toBeNull()
    expect((await owner.rpc('rate_limit_ai')).error?.code).toBe('54000')
  })

  it('category_totals só devolve nome, tipo e soma, respeitando janela e status', async () => {
    const cats = await owner.from('categories').select('id,name,kind').eq('company_id', company)
    if (cats.error) throw cats.error
    const expense = cats.data.find((c) => c.kind === 'expense')!
    const income = cats.data.find((c) => c.kind === 'income')!

    const rows = [
      {
        kind: 'expense',
        status: 'settled',
        description: 'Aluguel de teste',
        account_id: account,
        category_id: expense.id,
        amount: '100.00',
        competence_date: today,
        due_date: today,
      },
      {
        kind: 'expense',
        status: 'pending',
        description: 'Aluguel futuro',
        account_id: account,
        category_id: expense.id,
        amount: '50.00',
        competence_date: today,
        due_date: today,
      },
      {
        kind: 'expense',
        status: 'cancelled',
        description: 'Cancelado',
        account_id: account,
        category_id: expense.id,
        amount: '999.00',
        competence_date: today,
        due_date: today,
      },
      {
        kind: 'expense',
        status: 'settled',
        description: 'Fora da janela',
        account_id: account,
        category_id: expense.id,
        amount: '777.00',
        competence_date: '2020-01-01',
        due_date: '2020-01-01',
      },
      {
        kind: 'income',
        status: 'settled',
        description: 'Venda',
        account_id: account,
        category_id: income.id,
        amount: '30.00',
        competence_date: today,
        due_date: today,
      },
      {
        kind: 'transfer',
        status: 'settled',
        description: 'Transferência',
        account_id: account,
        category_id: expense.id,
        amount: '500.00',
        competence_date: today,
        due_date: today,
      },
    ]
    const inserted = await owner.from('transactions').insert(rows.map((r) => ({ company_id: company, ...r })))
    if (inserted.error) throw inserted.error

    const { data, error } = await owner.rpc('category_totals', { p_company: company, p_as_of: today, p_days: 90 })
    if (error) throw error

    const result = data as { name: string; kind: string; total: string }[]
    expect(result).toEqual([
      { name: expense.name, kind: 'expense', total: '150.00' },
      { name: income.name, kind: 'income', total: '30.00' },
    ])
    expect(Object.keys(result[0]).sort()).toEqual(['kind', 'name', 'total'])

    const forbidden = await outsider.rpc('category_totals', { p_company: company, p_as_of: today, p_days: 90 })
    expect(forbidden.error).toBeNull()
    expect(forbidden.data).toEqual([])
  })
})

afterAll(async () => {
  if (!admin) return
  if (company) await admin.from('companies').delete().eq('id', company)
  if (otherCompany) await admin.from('companies').delete().eq('id', otherCompany)
  await admin.from('plan_limits').delete().eq('plan', quotaPlan)
  if (userId) await admin.auth.admin.deleteUser(userId)
  if (outsiderId) await admin.auth.admin.deleteUser(outsiderId)
  if (viewerId) await admin.auth.admin.deleteUser(viewerId)
})

describe.runIf(!configured)('configuração', () => {
  it('pula os testes de IA sem SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY e SUPABASE_TEST_SERVICE_ROLE_KEY', () => {
    expect(configured).toBe(false)
  })
})
