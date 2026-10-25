import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Isolamento entre empresas e regras do banco, testados pela API pública (PostgREST) com a chave
 * anon — exatamente o que um usuário mal-intencionado conseguiria chamar. A chave service_role é
 * usada SÓ para criar/remover usuários de teste já confirmados e limpar os dados ao final.
 *
 * Cria 3 usuários temporários (A, B e C) em um projeto de TESTE. Não rode em produção.
 */
const URL = process.env.SUPABASE_TEST_URL
const ANON = process.env.SUPABASE_TEST_ANON_KEY
const SERVICE = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
const configured = !!(URL && ANON && SERVICE)

const run = Math.random().toString(36).slice(2, 8)
const password = `Teste-${run}-senha-123`
const opts = { auth: { persistSession: false, autoRefreshToken: false } }

interface Actor {
  id: string
  email: string
  sb: SupabaseClient
}

let admin: SupabaseClient
let A: Actor, B: Actor, C: Actor
let companyA: string, companyB: string
let accountA: string, accountB: string
let catExpenseA: string, catIncomeA: string
let txA: string

async function makeUser(label: string): Promise<Actor> {
  const email = `nexo-teste-${run}-${label}@example.com`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `Teste ${label}` } })
  if (error) throw error
  const sb = createClient(URL!, ANON!, opts)
  const { error: e2 } = await sb.auth.signInWithPassword({ email, password })
  if (e2) throw e2
  return { id: data.user.id, email, sb }
}

async function firstAccount(sb: SupabaseClient, company: string) {
  const { data, error } = await sb.from('accounts').select('id').eq('company_id', company).limit(1).single()
  if (error) throw error
  return data.id as string
}

const tx = (company: string, account: string, over: Record<string, unknown> = {}) => ({
  company_id: company,
  kind: 'expense',
  status: 'pending',
  description: 'Teste de isolamento',
  account_id: account,
  amount: '100.00',
  competence_date: '2026-01-10',
  due_date: '2026-01-20',
  ...over,
})

describe.skipIf(!configured)('isolamento entre empresas (RLS) e regras do banco', () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, opts)
    ;[A, B, C] = await Promise.all([makeUser('a'), makeUser('b'), makeUser('c')])

    const ra = await A.sb.rpc('create_company', { p_name: `Empresa A ${run}`, p_opening_balance: 1000 })
    const rb = await B.sb.rpc('create_company', { p_name: `Empresa B ${run}` })
    if (ra.error || rb.error) throw ra.error ?? rb.error
    companyA = ra.data as string
    companyB = rb.data as string
    accountA = await firstAccount(A.sb, companyA)
    accountB = await firstAccount(B.sb, companyB)

    const cats = await A.sb.from('categories').select('id,kind').eq('company_id', companyA)
    catExpenseA = cats.data!.find((c) => c.kind === 'expense')!.id
    catIncomeA = cats.data!.find((c) => c.kind === 'income')!.id

    const ins = await A.sb.from('transactions').insert(tx(companyA, accountA, { category_id: catExpenseA })).select('id').single()
    if (ins.error) throw ins.error
    txA = ins.data.id

    // A (owner) adiciona C como somente leitura — exercita a política de membros.
    const m = await A.sb.from('company_members').insert({ company_id: companyA, user_id: C.id, role: 'viewer' })
    if (m.error) throw m.error
  })

  afterAll(async () => {
    if (!admin) return
    await admin.from('companies').delete().in('id', [companyA, companyB].filter(Boolean))
    for (const u of [A, B, C].filter(Boolean)) await admin.auth.admin.deleteUser(u.id)
  })

  describe('usuário B tentando acessar a empresa A', () => {
    it('não lê lançamentos de A, nem filtrando pelo company_id', async () => {
      const direct = await B.sb.from('transactions').select('id').eq('company_id', companyA)
      expect(direct.error).toBeNull()
      expect(direct.data).toEqual([])
      const byId = await B.sb.from('transactions').select('id').eq('id', txA)
      expect(byId.data).toEqual([])
    })

    it('só enxerga a própria empresa e os próprios membros', async () => {
      const companies = await B.sb.from('companies').select('id')
      expect(companies.data!.map((c) => c.id)).toEqual([companyB])
      const members = await B.sb.from('company_members').select('user_id').eq('company_id', companyA)
      expect(members.data).toEqual([])
    })

    it('não lê contas, categorias, configurações, registro de ações nem perfis de A', async () => {
      for (const table of ['accounts', 'categories', 'company_settings', 'audit_logs', 'alert_states', 'scenarios', 'imports']) {
        const r = await B.sb.from(table).select('*').eq('company_id', companyA)
        expect(r.data, table).toEqual([])
      }
      const profile = await B.sb.from('profiles').select('id').eq('id', A.id)
      expect(profile.data).toEqual([])
    })

    it('não altera lançamento de A (UPDATE não afeta linhas)', async () => {
      const r = await B.sb.from('transactions').update({ amount: '999999.00' }).eq('id', txA).select('id')
      expect(r.data ?? []).toEqual([])
      const check = await A.sb.from('transactions').select('amount').eq('id', txA).single()
      expect(Number(check.data!.amount)).toBe(100)
    })

    it('não exclui lançamento de A', async () => {
      const r = await B.sb.from('transactions').delete().eq('id', txA).select('id')
      expect(r.data ?? []).toEqual([])
      const check = await A.sb.from('transactions').select('id').eq('id', txA)
      expect(check.data).toHaveLength(1)
    })

    it('não insere lançamento na empresa A', async () => {
      const r = await B.sb.from('transactions').insert(tx(companyA, accountA))
      expect(r.error?.code).toBe('42501')
    })

    it('não usa conta de A em lançamento da própria empresa (FK composta)', async () => {
      const r = await B.sb.from('transactions').insert(tx(companyB, accountA))
      expect(r.error).not.toBeNull()
    })

    it('não usa categoria de A em lançamento da própria empresa', async () => {
      const r = await B.sb.from('transactions').insert(tx(companyB, accountB, { category_id: catExpenseA }))
      expect(r.error).not.toBeNull()
    })

    it('não move lançamento próprio para a empresa A', async () => {
      const own = await B.sb.from('transactions').insert(tx(companyB, accountB)).select('id').single()
      expect(own.error).toBeNull()
      const r = await B.sb.from('transactions').update({ company_id: companyA }).eq('id', own.data!.id).select('id')
      expect(r.error !== null || (r.data ?? []).length === 0).toBe(true)
      const still = await B.sb.from('transactions').select('company_id').eq('id', own.data!.id).single()
      expect(still.data!.company_id).toBe(companyB)
    })

    it('não importa na empresa A pela função de importação', async () => {
      const r = await B.sb.rpc('import_transactions', {
        p_company: companyA,
        p_file_name: 'ataque.csv',
        p_file_hash: 'a'.repeat(64),
        p_rows: [{ kind: 'income', status: 'pending', description: 'x', account_id: accountA, amount: '1.00', competence_date: '2026-01-01', due_date: '2026-01-01' }],
        p_stats: { total_rows: 1, skipped: 0, errors: 0, warnings: 0 },
      })
      expect(r.error?.code).toBe('42501')
    })

    it('não se adiciona como membro de A', async () => {
      for (const role of ['owner', 'admin', 'member', 'viewer']) {
        const r = await B.sb.from('company_members').insert({ company_id: companyA, user_id: B.id, role })
        expect(r.error, role).not.toBeNull()
      }
    })

    it('não altera configurações nem estado de alertas de A', async () => {
      const s = await B.sb.from('company_settings').update({ alert_config: { safetyMargin: 0 } }).eq('company_id', companyA).select('company_id')
      expect(s.data ?? []).toEqual([])
      const a = await B.sb.from('alert_states').insert({ company_id: companyA, fingerprint: 'x', state: 'ignored' })
      expect(a.error?.code).toBe('42501')
    })

    it('não renomeia a empresa A', async () => {
      const r = await B.sb.from('companies').update({ name: 'Invadida' }).eq('id', companyA).select('id')
      expect(r.data ?? []).toEqual([])
    })
  })

  describe('sem autenticação', () => {
    it('a chave anon sozinha não lê nada', async () => {
      const anon = createClient(URL!, ANON!, opts)
      for (const table of ['transactions', 'companies', 'accounts', 'audit_logs']) {
        const r = await anon.from(table).select('id').limit(1)
        expect(r.data ?? [], table).toEqual([])
      }
      const rpc = await anon.rpc('create_company', { p_name: 'Anônima' })
      expect(rpc.error).not.toBeNull()
    })
  })

  describe('papel somente leitura (C, viewer em A)', () => {
    it('lê os dados de A', async () => {
      const r = await C.sb.from('transactions').select('id').eq('id', txA)
      expect(r.data).toHaveLength(1)
    })
    it('não cria, altera nem exclui', async () => {
      const ins = await C.sb.from('transactions').insert(tx(companyA, accountA))
      expect(ins.error?.code).toBe('42501')
      const upd = await C.sb.from('transactions').update({ description: 'x' }).eq('id', txA).select('id')
      expect(upd.data ?? []).toEqual([])
      const del = await C.sb.from('transactions').delete().eq('id', txA).select('id')
      expect(del.data ?? []).toEqual([])
    })
    it('não se promove a administrador', async () => {
      const r = await C.sb.from('company_members').update({ role: 'admin' }).eq('company_id', companyA).eq('user_id', C.id).select('role')
      expect(r.data ?? []).toEqual([])
    })
  })

  describe('regras de integridade no servidor (usuário A)', () => {
    const expectRejected = async (over: Record<string, unknown>) => {
      const r = await A.sb.from('transactions').insert(tx(companyA, accountA, over))
      expect(r.error, JSON.stringify(over)).not.toBeNull()
    }
    it('valor zero ou negativo', async () => {
      await expectRejected({ amount: '0' })
      await expectRejected({ amount: '-10.00' })
    })
    it('liquidado sem data, ou pendente com data de liquidação', async () => {
      await expectRejected({ status: 'settled' })
      await expectRejected({ status: 'pending', settled_date: '2026-01-10' })
    })
    it('liquidação no futuro', async () => {
      await expectRejected({ status: 'settled', settled_date: '2099-01-01' })
    })
    it('categoria de receita em despesa', async () => {
      await expectRejected({ category_id: catIncomeA })
    })
    it('transferência para a mesma conta, sem destino ou com categoria', async () => {
      await expectRejected({ kind: 'transfer', to_account_id: accountA })
      await expectRejected({ kind: 'transfer' })
      await expectRejected({ kind: 'expense', to_account_id: accountA })
    })
    it('descrição vazia ou longa demais', async () => {
      await expectRejected({ description: '   ' })
      await expectRejected({ description: 'x'.repeat(201) })
    })
    it('mesma origem de importação não entra duas vezes', async () => {
      const row = { kind: 'income', status: 'pending', description: 'Linha', account_id: accountA, amount: '10.00', competence_date: '2026-01-01', due_date: '2026-01-05', source_ref: `row:${run}` }
      const args = { p_company: companyA, p_file_name: 'a.csv', p_file_hash: 'b'.repeat(64), p_rows: [row], p_stats: { total_rows: 1, skipped: 0, errors: 0, warnings: 0 } }
      const first = await A.sb.rpc('import_transactions', args)
      expect(first.error).toBeNull()
      const again = await A.sb.rpc('import_transactions', args)
      expect(again.error?.code).toBe('23505')
      // A importação é atômica: a segunda tentativa não deixou registro de importação órfão.
      const imports = await A.sb.from('imports').select('id').eq('company_id', companyA)
      expect(imports.data).toHaveLength(1)
    })
    it('autoria e origem não são editáveis pelo cliente', async () => {
      await A.sb.from('transactions').update({ source: 'import', created_by: B.id, source_ref: 'forjado' }).eq('id', txA)
      const r = await A.sb.from('transactions').select('source,created_by,source_ref').eq('id', txA).single()
      expect(r.data).toEqual({ source: 'manual', created_by: A.id, source_ref: null })
    })
    it('registro de ações é gerado pelo servidor e não pode ser escrito pelo cliente', async () => {
      const logs = await A.sb.from('audit_logs').select('action,entity_id').eq('company_id', companyA).eq('entity_id', txA)
      expect(logs.data!.some((l) => l.action === 'create')).toBe(true)
      const forged = await A.sb.from('audit_logs').insert({ company_id: companyA, action: 'delete', entity: 'x', entity_id: 'x', summary: 'forjado' })
      expect(forged.error).not.toBeNull()
    })
    it('empresa não pode ser criada diretamente na tabela', async () => {
      const r = await A.sb.from('companies').insert({ name: 'Direta' })
      expect(r.error).not.toBeNull()
    })
  })
})

describe.runIf(!configured)('configuração', () => {
  it('pula os testes de banco sem SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY e SUPABASE_TEST_SERVICE_ROLE_KEY em .env.test.local', () => {
    expect(configured).toBe(false)
  })
})
