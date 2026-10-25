import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseRepository } from './supabaseRepository'

interface FakeBuilder {
  update(payload: Record<string, unknown>): FakeBuilder
  eq(column: string, value: unknown): FakeBuilder
  select(columns: string): Promise<{ data: unknown[]; error: null }>
}

function fakeClient() {
  const calls: { table: string; payload: Record<string, unknown> }[] = []
  let table = ''
  const builder: FakeBuilder = {
    update(payload) {
      calls.push({ table, payload })
      return builder
    },
    eq() {
      return builder
    },
    select() {
      // PostgREST devolve 0 linhas (sem erro) quando o RLS bloqueia o UPDATE.
      return Promise.resolve({ data: [], error: null })
    },
  }
  return {
    client: { from(name: string) { table = name; return builder } } as unknown as SupabaseClient,
    calls,
  }
}

interface MutationCall {
  table: string
  op: 'update' | 'delete'
  payload?: Record<string, unknown>
  filters: { column: string; value: unknown }[]
}

function mutationClient(rows: unknown[]) {
  const calls: MutationCall[] = []
  let table = ''
  let current: MutationCall | null = null
  const builder: Record<string, unknown> = {}
  builder.update = (payload: Record<string, unknown>) => {
    current = { table, op: 'update', payload, filters: [] }
    calls.push(current)
    return builder
  }
  builder.delete = () => {
    current = { table, op: 'delete', filters: [] }
    calls.push(current)
    return builder
  }
  builder.eq = (column: string, value: unknown) => {
    current?.filters.push({ column, value })
    return builder
  }
  builder.neq = (column: string, value: unknown) => {
    current?.filters.push({ column, value })
    return builder
  }
  builder.select = () => Promise.resolve({ data: rows, error: null })
  return {
    client: {
      from(name: string) {
        table = name
        return builder
      },
    } as unknown as SupabaseClient,
    calls,
  }
}

describe('repositório Supabase e edição de configurações', () => {
  it('detecta update bloqueado pelo RLS e nunca envia company_id no payload', async () => {
    const { client, calls } = fakeClient()
    const repo = new SupabaseRepository(client, 'empresa-1', 'member')

    await expect(repo.updateCompanyName('Empresa Nova')).rejects.toThrow(/sem permissão/)
    expect(calls[0]).toEqual({ table: 'companies', payload: { name: 'Empresa Nova' } })
    expect(calls[0].payload).not.toHaveProperty('company_id')

    await expect(repo.updateAccountOpeningBalance('conta-1', -12345)).rejects.toThrow(/sem permissão/)
    expect(calls[1]).toEqual({ table: 'accounts', payload: { opening_balance: '-123.45' } })
    expect(calls[1].payload).not.toHaveProperty('company_id')
  })

  it('valida entrada antes de chamar o banco', async () => {
    const { client, calls } = fakeClient()
    const repo = new SupabaseRepository(client, 'empresa-1', 'viewer')
    await expect(repo.updateCompanyName(' a ')).rejects.toThrow(/2 a 120/)
    await expect(repo.updateAccountOpeningBalance('conta-1', 1.5)).rejects.toThrow(/inválido/)
    expect(calls).toHaveLength(0)
  })
})

describe('equipe no repositório Supabase', () => {
  it('cria convite pela RPC, normaliza o e-mail e nunca envia company_id no payload', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> }[] = []
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args })
        return Promise.resolve({ data: { id: 'convite-1', token: 'token-secreto' }, error: null })
      },
    } as unknown as SupabaseClient
    const repo = new SupabaseRepository(client, 'empresa-1', 'owner')

    const invite = await repo.createInvite({ email: '  Ana@Exemplo.com ', role: 'admin' })
    expect(invite).toMatchObject({ id: 'convite-1', email: 'ana@exemplo.com', role: 'admin', token: 'token-secreto' })
    expect(rpcCalls[0]).toEqual({
      name: 'create_invite',
      args: { p_company: 'empresa-1', p_email: 'ana@exemplo.com', p_role: 'admin' },
    })
    expect(rpcCalls[0].args).not.toHaveProperty('company_id')
  })

  it('valida e-mail, papel e revogação sem chamar o banco quando inválidos', async () => {
    const rpcCalls: string[] = []
    const client = {
      rpc(name: string) {
        rpcCalls.push(name)
        return Promise.resolve({ data: null, error: null })
      },
    } as unknown as SupabaseClient
    const repo = new SupabaseRepository(client, 'empresa-1', 'owner')
    await expect(repo.createInvite({ email: 'invalido', role: 'member' })).rejects.toThrow(/válido/)
    await expect(repo.createInvite({ email: 'a@b.co', role: 'owner' as never })).rejects.toThrow(/Papel inválido/)
    await expect(repo.updateMemberRole('u1', 'owner' as never)).rejects.toThrow(/Papel inválido/)
    expect(rpcCalls).toHaveLength(0)

    await repo.revokeInvite('convite-1')
    expect(rpcCalls).toEqual(['revoke_invite'])
  })

  it('detecta update/delete bloqueados pelo RLS e filtra o owner', async () => {
    const { client, calls } = mutationClient([])
    const repo = new SupabaseRepository(client, 'empresa-1', 'admin')

    await expect(repo.updateMemberRole('membro-1', 'viewer')).rejects.toThrow(/proprietário|permissão/)
    expect(calls[0]).toMatchObject({
      table: 'company_members',
      op: 'update',
      payload: { role: 'viewer' },
      filters: [
        { column: 'company_id', value: 'empresa-1' },
        { column: 'user_id', value: 'membro-1' },
        { column: 'role', value: 'owner' },
      ],
    })
    expect(calls[0].payload).not.toHaveProperty('company_id')

    await expect(repo.removeMember('membro-1')).rejects.toThrow(/proprietário|permissão/)
    expect(calls[1]).toMatchObject({
      table: 'company_members',
      op: 'delete',
      filters: [
        { column: 'company_id', value: 'empresa-1' },
        { column: 'user_id', value: 'membro-1' },
        { column: 'role', value: 'owner' },
      ],
    })
  })
})
