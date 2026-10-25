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
