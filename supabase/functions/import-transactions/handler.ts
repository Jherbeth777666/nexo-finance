import { createClient } from '@supabase/supabase-js'
import { IMPORT_LIMITS } from '@/domain/import/pipeline'
import { validateImportBatch } from '@/domain/import/serverValidation'
import { todayIn } from '@/lib/dates'

/**
 * Edge Function de importação.
 * - CORS restrito a ALLOWED_ORIGIN (sem fallback "*") e somente POST.
 * - Limite de 5 MB e Authorization obrigatório.
 * - Consome rate_limit_import_validation() (30 validações a cada 10 min) antes de ler os dados da empresa.
 * - Valida o lote com a MESMA função pura do domínio e só então chama import_transactions,
 *   que aplica RLS, regras do banco e o limite de 10 importações a cada 10 minutos.
 * Nunca registra linhas, tokens ou o JWT.
 */

const MAX_BYTES = IMPORT_LIMITS.maxBytes
const ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type'

function corsHeaders(allowedOrigin: string | null, origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
  if (allowedOrigin && origin === allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return headers
}

function json(body: unknown, status: number, allowedOrigin: string | null, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(allowedOrigin, origin), 'Content-Type': 'application/json' },
  })
}

function nonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function validMeta(body: Record<string, unknown>, rows: unknown[]): boolean {
  const fileName = body.fileName
  const fileHash = body.fileHash
  const stats = body.stats
  if (typeof fileName !== 'string' || fileName.length < 1 || fileName.length > 255) return false
  if (typeof fileHash !== 'string' || !/^[0-9a-f]{64}$/.test(fileHash)) return false
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return false
  const s = stats as Record<string, unknown>
  if (!nonNegativeInt(s.totalRows) || !nonNegativeInt(s.skipped) || !nonNegativeInt(s.errors) || !nonNegativeInt(s.warnings)) return false
  return s.totalRows >= rows.length
}

Deno.serve(async (req) => {
  const allowedOrigin = Deno.env.get('ALLOWED_ORIGIN')?.replace(/\/$/, '') ?? null
  const origin = req.headers.get('Origin')

  if (!allowedOrigin) return json({ error: 'Serviço indisponível.' }, 500, null, origin)

  if (req.method === 'OPTIONS') {
    if (origin && origin !== allowedOrigin) return new Response(null, { status: 403, headers: { Vary: 'Origin' } })
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin, origin) })
  }
  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: { ...corsHeaders(allowedOrigin, origin), Allow: 'POST, OPTIONS' } })
  }
  if (origin && origin !== allowedOrigin) return json({ error: 'Origem não permitida.' }, 403, allowedOrigin, origin)

  const auth = req.headers.get('Authorization')
  if (!auth || !/^Bearer\s+\S+$/i.test(auth)) return json({ error: 'Não autorizado.' }, 401, allowedOrigin, origin)
  const token = auth.replace(/^Bearer\s+/i, '')

  const declaredLength = req.headers.get('Content-Length')
  if (declaredLength && Number(declaredLength) > MAX_BYTES) return json({ error: 'Arquivo grande demais.' }, 413, allowedOrigin, origin)

  const text = await req.text()
  if (new TextEncoder().encode(text).length > MAX_BYTES) return json({ error: 'Arquivo grande demais.' }, 413, allowedOrigin, origin)

  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    body = parsed as Record<string, unknown>
  } catch {
    return json({ error: 'Requisição inválida.' }, 400, allowedOrigin, origin)
  }

  const companyId = body.companyId
  const rows = body.rows
  if (typeof companyId !== 'string' || !companyId || !Array.isArray(rows) || !validMeta(body, rows)) {
    return json({ error: 'Requisição inválida.' }, 400, allowedOrigin, origin)
  }

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!url || !anonKey) return json({ error: 'Serviço indisponível.' }, 500, allowedOrigin, origin)

  const sb = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data: userData, error: userError } = await sb.auth.getUser(token)
  if (userError || !userData.user) return json({ error: 'Não autorizado.' }, 401, allowedOrigin, origin)

  const { error: rateError } = await sb.rpc('rate_limit_import_validation')
  if (rateError) {
    if (rateError.code === '54000') return json({ error: 'Muitas solicitações. Tente novamente mais tarde.' }, 429, allowedOrigin, origin)
    return json({ error: 'Não autorizado.' }, 401, allowedOrigin, origin)
  }

  const [company, accounts, categories] = await Promise.all([
    sb.from('companies').select('id,timezone').eq('id', companyId).maybeSingle(),
    sb.from('accounts').select('id').eq('company_id', companyId),
    sb.from('categories').select('id,name,kind,fixed').eq('company_id', companyId),
  ])
  if (company.error || !company.data) return json({ error: 'Empresa não encontrada.' }, 404, allowedOrigin, origin)
  if (accounts.error || categories.error) return json({ error: 'Não foi possível validar os dados.' }, 400, allowedOrigin, origin)

  const timezone = typeof company.data.timezone === 'string' ? company.data.timezone : 'America/Sao_Paulo'
  const validation = validateImportBatch(rows, {
    accounts: accounts.data as { id: string }[],
    categories: categories.data as { id: string; name: string; kind: 'income' | 'expense'; fixed?: boolean }[],
    today: todayIn(timezone),
  })
  if (!validation.ok) return json({ error: 'Importação recusada.', errors: validation.errors }, 400, allowedOrigin, origin)

  const rpcRows = validation.value.map((r) => ({
    kind: r.kind,
    status: r.status,
    description: r.description,
    counterparty: r.counterparty ?? null,
    category_id: r.categoryId,
    account_id: r.accountId,
    amount: `${r.amount < 0 ? '-' : ''}${Math.floor(Math.abs(r.amount) / 100)}.${String(Math.abs(r.amount) % 100).padStart(2, '0')}`,
    competence_date: r.competenceDate,
    due_date: r.dueDate,
    settled_date: r.settledDate,
    notes: r.notes ?? null,
    source_ref: r.sourceRef ?? null,
  }))

  const stats = body.stats as Record<string, number>
  const { data: importId, error: importError } = await sb.rpc('import_transactions', {
    p_company: companyId,
    p_file_name: body.fileName,
    p_file_hash: body.fileHash,
    p_rows: rpcRows,
    p_stats: {
      total_rows: stats.totalRows,
      skipped: stats.skipped,
      errors: stats.errors,
      warnings: stats.warnings,
    },
  })
  if (importError) {
    // 54000 cobre tanto o rate limit quanto o limite de linhas do plano; só o primeiro é 429.
    if (importError.code === '54000' && /Muitas solicitações/.test(importError.message ?? '')) {
      return json({ error: 'Limite de importações atingido. Tente novamente mais tarde.' }, 429, allowedOrigin, origin)
    }
    if (importError.code === '42501') return json({ error: 'Sem permissão para importar nesta empresa.' }, 403, allowedOrigin, origin)
    if (importError.code === '23505') return json({ error: 'Registro duplicado: já existe um lançamento com esta origem.' }, 409, allowedOrigin, origin)
    return json({ error: 'Não foi possível concluir a importação.' }, 400, allowedOrigin, origin)
  }

  return json({ importId }, 200, allowedOrigin, origin)
})
