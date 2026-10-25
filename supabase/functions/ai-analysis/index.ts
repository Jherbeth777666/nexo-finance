import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AgentKind, AnalysisResult, Facts, Review } from '@/domain/ai/analysis'
import { reviewAnalysis } from '@/domain/ai/analysis'
import { buildCashFacts, buildExpenseFacts, buildScenarioFacts, computeInputHash } from '@/domain/ai/facts'
import { parseAnalysisResponse } from '@/domain/ai/parse'
import { buildPrompt, PROMPT_VERSION } from '@/domain/ai/prompts'
import { AiProviderError, createProvider, type AiProvider } from '@/domain/ai/providers'
import { numericToCents } from '@/data/supabaseMapping'
import { todayIn } from '@/lib/dates'

/**
 * Edge Function de análise por IA.
 * - CORS restrito a ALLOWED_ORIGIN, somente POST, payload máximo de 4 KB e JWT obrigatório.
 * - Desligada por padrão: sem AI_PROVIDER válido/AI_API_KEY responde 503 sem tocar no banco.
 * - Só agregados vão ao provedor (nunca descrições, contrapartes ou notas).
 * - rate_limit_ai() e ai_quota_reserve() usam o JWT do usuário; service_role só finaliza a linha reservada.
 * - Nunca registra prompt, resposta, fatos, JWT ou chave. Logs: { agent, provider, durationMs, status }.
 */

const MAX_BYTES = 4 * 1024
const ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type'
const AGENTS: AgentKind[] = ['cash', 'expenses', 'scenarios']

class EdgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'EdgeError'
  }
}

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

function isAgent(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENTS as string[]).includes(value)
}

function cents(value: unknown): number {
  if (typeof value === 'number' || typeof value === 'string' || value === null) return numericToCents(value)
  return 0
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
  if (declaredLength && Number(declaredLength) > MAX_BYTES) return json({ error: 'Requisição grande demais.' }, 413, allowedOrigin, origin)
  const text = await req.text()
  if (new TextEncoder().encode(text).length > MAX_BYTES) return json({ error: 'Requisição grande demais.' }, 413, allowedOrigin, origin)

  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    body = parsed as Record<string, unknown>
  } catch {
    return json({ error: 'Requisição inválida.' }, 400, allowedOrigin, origin)
  }

  const companyId = body.companyId
  const agent = body.agent
  if (typeof companyId !== 'string' || !companyId || !isAgent(agent)) {
    return json({ error: 'Requisição inválida.' }, 400, allowedOrigin, origin)
  }

  const providerName = (Deno.env.get('AI_PROVIDER') ?? 'none').trim().toLowerCase()
  const apiKey = Deno.env.get('AI_API_KEY')
  const model = Deno.env.get('AI_MODEL')
  if (providerName !== 'gemini' && providerName !== 'fake') {
    return json({ error: 'IA não configurada neste ambiente.' }, 503, allowedOrigin, origin)
  }
  let provider: AiProvider
  try {
    provider = createProvider({ provider: providerName, apiKey, model })
  } catch {
    return json({ error: 'IA não configurada neste ambiente.' }, 503, allowedOrigin, origin)
  }

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return json({ error: 'Serviço indisponível.' }, 500, allowedOrigin, origin)

  const sb = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  // service_role é usado SOMENTE para finalizar a linha reservada pela cota (com o JWT do usuário).
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: userData, error: userError } = await sb.auth.getUser(token)
  if (userError || !userData.user) return json({ error: 'Não autorizado.' }, 401, allowedOrigin, origin)

  const { error: rateError } = await sb.rpc('rate_limit_ai')
  if (rateError) {
    if (rateError.code === '54000') return json({ error: 'Muitas solicitações. Tente novamente em alguns minutos.' }, 429, allowedOrigin, origin)
    return json({ error: 'Não autorizado.' }, 401, allowedOrigin, origin)
  }

  const { data: company, error: companyError } = await sb.from('companies').select('id,timezone').eq('id', companyId).maybeSingle()
  if (companyError || !company) return json({ error: 'Empresa não encontrada.' }, 404, allowedOrigin, origin)

  const timezone = typeof company.timezone === 'string' ? company.timezone : 'America/Sao_Paulo'
  const asOf = todayIn(timezone)
  const started = Date.now()

  try {
    const facts = await loadFacts(sb, agent, companyId, asOf)
    const inputHash = await computeInputHash(agent, facts, PROMPT_VERSION)

    const cached = await readCache(sb, companyId, agent, inputHash, facts)
    if (cached) return json({ ...cached, facts, cached: true, status: 'ok', provider: provider.name }, 200, allowedOrigin, origin)

    const { data: reservation, error: quotaError } = await sb.rpc('ai_quota_reserve', {
      p_company: companyId,
      p_agent: agent,
      p_input_hash: inputHash,
    })
    if (quotaError || typeof reservation !== 'string') {
      if (quotaError?.code === '54000') return json({ error: 'Cota mensal de análises de IA esgotada.' }, 429, allowedOrigin, origin)
      if (quotaError?.code === '42501') return json({ error: 'Sem permissão para analisar esta empresa.' }, 403, allowedOrigin, origin)
      return json({ error: 'Não foi possível verificar a cota de análises.' }, 500, allowedOrigin, origin)
    }

    const prompt = buildPrompt(agent, facts)
    let generated: { text: string; model: string }
    try {
      generated = await provider.generate({ agent, system: prompt.system, user: prompt.user, timeoutMs: 15_000 })
    } catch (error) {
      const durationMs = Date.now() - started
      const providerModel = provider.name === 'gemini' ? (model ?? null) : provider.name
      await finalize(admin, reservation, {
        result: null,
        review: null,
        provider: provider.name,
        model: providerModel,
        duration_ms: durationMs,
        status: 'error',
      })
      console.error(JSON.stringify({ agent, provider: provider.name, durationMs, status: 'error' }))
      const timeout = error instanceof AiProviderError && error.code === 'timeout'
      return json(
        { error: timeout ? 'O provedor de IA demorou além do limite.' : 'Não foi possível gerar a análise.' },
        timeout ? 504 : 502,
        allowedOrigin,
        origin,
      )
    }

    const parsed = parseAnalysisResponse(generated.text, agent, facts)
    const durationMs = Date.now() - started
    const status = parsed.review.valid ? 'ok' : 'rejected'
    const saved = await finalize(admin, reservation, {
      result: parsed.review.valid ? parsed.analysis : null,
      review: parsed.review,
      provider: provider.name,
      model: provider.name === 'gemini' ? generated.model : provider.name,
      duration_ms: durationMs,
      status,
    })
    if (!saved) return json({ error: 'Não foi possível registrar a análise.' }, 500, allowedOrigin, origin)

    return json({ analysis: parsed.analysis, facts, review: parsed.review, cached: false, status, provider: provider.name }, 200, allowedOrigin, origin)
  } catch (error) {
    if (error instanceof EdgeError) return json({ error: error.message }, error.status, allowedOrigin, origin)
    console.error(JSON.stringify({ agent, provider: provider.name, durationMs: Date.now() - started, status: 'error' }))
    return json({ error: 'Não foi possível gerar a análise.' }, 500, allowedOrigin, origin)
  }
})

async function readCache(
  sb: SupabaseClient,
  companyId: string,
  agent: AgentKind,
  inputHash: string,
  facts: Facts,
): Promise<{ analysis: AnalysisResult; review: Review } | null> {
  const { data, error } = await sb
    .from('ai_analyses')
    .select('result,review')
    .eq('company_id', companyId)
    .eq('agent', agent)
    .eq('input_hash', inputHash)
    .eq('status', 'ok')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  const row = data as { result?: unknown; review?: unknown }
  const stored = row.review as { valid?: unknown } | null
  if (!row.result || stored?.valid !== true) return null
  try {
    // Nunca confie no cache sem reexecutar o revisor com os fatos atuais.
    const review = reviewAnalysis(row.result as AnalysisResult, facts)
    return review.valid ? { analysis: row.result as AnalysisResult, review } : null
  } catch {
    return null
  }
}

async function finalize(
  admin: SupabaseClient,
  reservationId: string,
  row: {
    result: AnalysisResult | null
    review: Review | null
    provider: string
    model: string | null
    duration_ms: number
    status: 'ok' | 'rejected' | 'error'
  },
): Promise<boolean> {
  // Só atualiza a linha reservada pela cota; nunca cria linha nova fora da cota.
  const { data, error } = await admin.from('ai_analyses').update(row).eq('id', reservationId).eq('status', 'pending').select('id')
  return !error && Array.isArray(data) && data.length === 1
}

async function loadFacts(sb: SupabaseClient, agent: AgentKind, companyId: string, asOf: string): Promise<Facts> {
  if (agent === 'cash') {
    const { data, error } = await sb.rpc('base_projection', { p_company: companyId, p_as_of: asOf, p_days: 30 })
    if (error || !Array.isArray(data) || !data.length) throw new EdgeError(400, 'Não foi possível calcular a projeção de caixa.')
    const rows = data as BaseProjectionRow[]
    const first = rows[0]
    return buildCashFacts({
      asOf,
      horizonDays: 30,
      startBalance: cents(first.start_balance),
      endBalance: cents(first.end_balance),
      totalIn: cents(first.total_in),
      totalOut: cents(first.total_out),
      minBalance: cents(first.min_balance),
      minDate: first.min_date,
      firstNegativeDate: first.first_negative_date,
      negativeDays: first.negative_days,
      pressureDays: rows
        .filter((r) => r.pressure_rank !== null)
        .sort((a, b) => (a.pressure_rank ?? 0) - (b.pressure_rank ?? 0))
        .map((r) => ({ date: r.day, inflow: cents(r.inflow), outflow: cents(r.outflow) })),
      excluded: {
        overdueReceivables: { amount: cents(first.overdue_receivables_amount), count: first.overdue_receivables_count },
      },
    })
  }

  if (agent === 'expenses') {
    const { data, error } = await sb.rpc('category_totals', { p_company: companyId, p_as_of: asOf, p_days: 90 })
    if (error || !Array.isArray(data)) throw new EdgeError(400, 'Não foi possível calcular as categorias de despesa.')
    const rows = data as { name: string; kind: 'income' | 'expense'; total: string | number }[]
    return buildExpenseFacts(
      rows.map((r) => ({ name: r.name, kind: r.kind, total: cents(r.total) })),
      asOf,
      90,
    )
  }

  const { data, error } = await sb
    .from('scenarios')
    .select('horizon_days,as_of,result_summary')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error || !Array.isArray(data)) throw new EdgeError(400, 'Não foi possível carregar os cenários.')
  const rows = data as { horizon_days: number; as_of: string; result_summary: Record<string, unknown> | null }[]
  return buildScenarioFacts(
    rows.map((r) => {
      const summary = r.result_summary ?? {}
      return {
        horizonDays: r.horizon_days,
        asOf: r.as_of,
        resultSummary: {
          currentMin: cents(summary.currentMin),
          alternativeMin: cents(summary.alternativeMin),
          endDelta: cents(summary.endDelta),
          firstNegative: typeof summary.firstNegative === 'string' ? summary.firstNegative : null,
        },
      }
    }),
    asOf,
  )
}

interface BaseProjectionRow {
  day: string
  inflow: string | number
  outflow: string | number
  pressure_rank: number | null
  start_balance: string | number
  end_balance: string | number
  total_in: string | number
  total_out: string | number
  min_balance: string | number
  min_date: string
  first_negative_date: string | null
  negative_days: number
  overdue_receivables_amount: string | number
  overdue_receivables_count: number
}
