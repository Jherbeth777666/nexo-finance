import type { AgentKind } from './analysis'

export type AiProviderName = 'none' | 'gemini' | 'fake'

export interface AiGenerationRequest {
  agent: AgentKind
  system: string
  user: string
  timeoutMs?: number
}

export interface AiGenerationResult {
  text: string
  model: string
  durationMs: number
}

export type AiProviderErrorCode = 'not_configured' | 'timeout' | 'http' | 'empty_response' | 'network'

export class AiProviderError extends Error {
  constructor(
    readonly code: AiProviderErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AiProviderError'
  }
}

export interface AiProvider {
  readonly name: AiProviderName
  generate(request: AiGenerationRequest): Promise<AiGenerationResult>
}

export const DEFAULT_AI_TIMEOUT_MS = 15_000

/** Padrão seguro: nenhum provedor é chamado enquanto o ambiente não for configurado. */
export class NoneProvider implements AiProvider {
  readonly name = 'none' as const
  async generate(_request?: AiGenerationRequest): Promise<AiGenerationResult> {
    throw new AiProviderError('not_configured', 'IA não configurada neste ambiente.')
  }
}

/** Determinístico e sem rede — usado nos testes e no desenvolvimento local. */
export class FakeProvider implements AiProvider {
  readonly name = 'fake' as const
  constructor(private readonly options: { text?: string; model?: string } = {}) {}

  async generate(request: AiGenerationRequest): Promise<AiGenerationResult> {
    return {
      text: this.options.text ?? defaultFakeText(request.agent),
      model: this.options.model ?? 'fake',
      durationMs: 0,
    }
  }
}

export interface GeminiProviderOptions {
  apiKey: string
  model: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const
  private readonly apiKey: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey.trim() || !options.model.trim()) throw new AiProviderError('not_configured', 'IA não configurada neste ambiente.')
    this.apiKey = options.apiKey.trim()
    this.model = options.model.trim()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async generate(request: AiGenerationRequest): Promise<AiGenerationResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs ?? this.timeoutMs))
    const started = Date.now()
    // A chave vai no header, nunca na URL: erros de rede não podem registrar a credencial.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024, temperature: 0.2 },
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new AiProviderError('http', `Provedor de IA respondeu com status ${response.status}.`)
      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new AiProviderError('empty_response', 'Provedor de IA não retornou JSON.')
      }
      const text = extractGeminiText(data)
      if (!text) throw new AiProviderError('empty_response', 'Provedor de IA não retornou texto.')
      return { text, model: this.model, durationMs: Date.now() - started }
    } catch (error) {
      if (error instanceof AiProviderError) throw error
      if (controller.signal.aborted) throw new AiProviderError('timeout', 'O provedor de IA demorou além do limite.')
      throw new AiProviderError('network', 'Não foi possível contatar o provedor de IA.')
    } finally {
      clearTimeout(timeout)
    }
  }
}

export interface AiProviderConfig {
  provider?: string | null
  apiKey?: string | null
  model?: string | null
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** `none` é o padrão (inclusive para valores desconhecidos). `gemini` sem chave/modelo falha fechado. */
export function createProvider(config: AiProviderConfig): AiProvider {
  const name = (config.provider ?? '').trim().toLowerCase()
  if (name === 'gemini') {
    return new GeminiProvider({
      apiKey: config.apiKey ?? '',
      model: config.model ?? '',
      timeoutMs: config.timeoutMs,
      fetchImpl: config.fetchImpl,
    })
  }
  if (name === 'fake') return new FakeProvider()
  return new NoneProvider()
}

function extractGeminiText(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const candidates = (data as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates)) return ''
  const first = candidates[0]
  if (!first || typeof first !== 'object') return ''
  const parts = (first as { content?: { parts?: unknown } }).content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join('')
    .trim()
}

function defaultFakeText(agent: AgentKind): string {
  return JSON.stringify({
    agent,
    summary: 'Análise simulada por provedor de teste, sem chamada externa.',
    period: { start: '2000-01-01', end: '2000-01-01' },
    evidence: [],
    assumptions: ['Execução do provedor fake para testes.'],
    limitations: ['Simulação: não representa uma análise real.'],
    suggestedActions: [],
  })
}
