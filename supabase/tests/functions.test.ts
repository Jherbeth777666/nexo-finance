import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { todayIn } from '@/lib/dates'

/**
 * Edge Functions publicadas (import-transactions e ai-analysis), chamadas como o app chama:
 * functions.invoke com o JWT do usuário. Roda só com as variáveis do projeto de TESTE e depois de
 * `npm run functions:deploy`; sem elas, é pulada como as demais suítes.
 */
const URL = process.env.SUPABASE_TEST_URL
const ANON = process.env.SUPABASE_TEST_ANON_KEY
const SERVICE = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
const configured = !!(URL && ANON && SERVICE)

const run = Math.random().toString(36).slice(2, 8)
const password = `Teste-${run}-senha-123`
const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const today = todayIn('America/Sao_Paulo')

let admin: SupabaseClient
let owner: SupabaseClient
let userId = ''
let company = ''
let account = ''
let expenseCategory = ''

/** Corpo de erro de uma resposta não 2xx do functions.invoke. */
async function errorBody(error: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!error || typeof error !== 'object') throw new Error('Esperava um erro HTTP da função, mas a chamada não falhou.')
  const response = (error as { context?: unknown }).context
  if (!(response instanceof Response)) throw error
  const text = await response.text()
  try {
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  } catch {
    // O gateway pode responder texto puro (ex.: 401 antes de chegar à função).
    return { status: response.status, body: { raw: text } }
  }
}

const row = (over: Record<string, unknown> = {}) => ({
  kind: 'expense',
  status: 'pending',
  description: `Linha ${run}`,
  accountId: account,
  categoryId: expenseCategory,
  amount: 12345,
  competenceDate: today,
  dueDate: today,
  settledDate: null,
  sourceRef: `row:${run}:${Math.random().toString(36).slice(2, 8)}`,
  ...over,
})

const body = (rows: unknown[]) => ({
  companyId: company,
  fileName: 'teste.csv',
  fileHash: 'a'.repeat(64),
  stats: { totalRows: rows.length, skipped: 0, errors: 0, warnings: 0 },
  rows,
})

describe.skipIf(!configured)('Edge Functions publicadas', () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, opts)
    const email = `nexo-fn-${run}@example.com`
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'Teste functions' } })
    if (created.error) throw created.error
    userId = created.data.user.id
    owner = createClient(URL!, ANON!, opts)
    const signIn = await owner.auth.signInWithPassword({ email, password })
    if (signIn.error) throw signIn.error

    const co = await owner.rpc('create_company', { p_name: `Functions ${run}` })
    if (co.error) throw co.error
    company = co.data as string
    const acc = await owner.from('accounts').select('id').eq('company_id', company).limit(1).single()
    if (acc.error) throw acc.error
    account = acc.data.id as string
    const cat = await owner.from('categories').select('id').eq('company_id', company).eq('kind', 'expense').limit(1).single()
    if (cat.error) throw cat.error
    expenseCategory = cat.data.id as string
  })

  it('import-transactions valida no servidor e importa com o JWT do usuário', async () => {
    const { data, error } = await owner.functions.invoke('import-transactions', { body: body([row()]) })
    expect(error).toBeNull()
    const importId = (data as { importId?: string }).importId
    expect(importId).toMatch(/^[0-9a-f-]{36}$/)

    const tx = await owner.from('transactions').select('amount,source,import_id').eq('company_id', company).eq('import_id', importId!)
    expect(tx.data).toHaveLength(1)
    expect(Number(tx.data![0].amount)).toBe(123.45)
    expect(tx.data![0].source).toBe('import')
  })

  it('import-transactions recusa linha inválida com erro por linha, sem gravar nada', async () => {
    const before = await owner.from('imports').select('id').eq('company_id', company)
    const { error } = await owner.functions.invoke('import-transactions', { body: body([row({ amount: -5 })]) })
    const { status, body: res } = await errorBody(error)
    expect(status).toBe(400)
    expect(Array.isArray(res.errors)).toBe(true)
    const after = await owner.from('imports').select('id').eq('company_id', company)
    expect(after.data).toHaveLength(before.data!.length)
  })

  it('import-transactions exige usuário autenticado', async () => {
    const anon = createClient(URL!, ANON!, opts)
    const { error } = await anon.functions.invoke('import-transactions', { body: body([row()]) })
    expect([401, 403]).toContain((await errorBody(error)).status)
  })

  it('ai-analysis exige usuário autenticado', async () => {
    const anon = createClient(URL!, ANON!, opts)
    const { error } = await anon.functions.invoke('ai-analysis', { body: { companyId: company, agent: 'cash' } })
    expect([401, 403]).toContain((await errorBody(error)).status)
  })

  it('ai-analysis responde que a IA não está configurada (AI_PROVIDER ausente)', async () => {
    const { error } = await owner.functions.invoke('ai-analysis', { body: { companyId: company, agent: 'cash' } })
    const { status, body: res } = await errorBody(error)
    expect(status).toBe(503)
    expect(res.error).toBe('IA não configurada neste ambiente.')
  })
})

afterAll(async () => {
  if (!admin) return
  if (company) await admin.from('companies').delete().eq('id', company)
  if (userId) await admin.auth.admin.deleteUser(userId)
})

describe.runIf(!configured)('configuração', () => {
  it('pula os testes das Edge Functions sem SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY e SUPABASE_TEST_SERVICE_ROLE_KEY', () => {
    expect(configured).toBe(false)
  })
})
