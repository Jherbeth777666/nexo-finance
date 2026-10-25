import { AiProviderError, createProvider, FakeProvider, GeminiProvider, NoneProvider } from './providers'

const request = { agent: 'cash' as const, system: 'sistema', user: 'usuário' }
const geminiResponse = (text: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  }) as Response

describe('provedores de IA', () => {
  it('none é o padrão e falha fechado', async () => {
    expect(createProvider({}).name).toBe('none')
    expect(createProvider({ provider: 'desconhecido' }).name).toBe('none')
    await expect(new NoneProvider().generate(request)).rejects.toMatchObject({ code: 'not_configured' })
  })

  it('gemini exige chave e modelo', () => {
    expect(() => createProvider({ provider: 'gemini' })).toThrow(AiProviderError)
    expect(() => createProvider({ provider: 'gemini', apiKey: 'k' })).toThrow(AiProviderError)
    expect(createProvider({ provider: 'gemini', apiKey: 'k', model: 'm' }).name).toBe('gemini')
  })

  it('fake é determinístico e não acessa a rede', async () => {
    const fake = new FakeProvider({ text: '{"ok":true}' })
    const a = await fake.generate(request)
    const b = await fake.generate(request)
    expect(a).toEqual(b)
    expect(a.text).toBe('{"ok":true}')
    expect(a.model).toBe('fake')
  })

  it('gemini envia a chave no header, nunca na URL, e respeita modelo e limites', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return geminiResponse('{"resposta":true}')
    }) as unknown as typeof fetch
    const provider = new GeminiProvider({ apiKey: 'segredo-nao-vaze', model: 'gemini-2.0-flash', fetchImpl })

    const result = await provider.generate({ ...request, timeoutMs: 1_000 })
    expect(result).toMatchObject({ text: '{"resposta":true}', model: 'gemini-2.0-flash' })
    expect(calls[0].url).not.toContain('segredo-nao-vaze')
    expect(calls[0].url).toContain('gemini-2.0-flash')
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('segredo-nao-vaze')
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.maxOutputTokens).toBe(1024)
    expect(body.systemInstruction.parts[0].text).toBe('sistema')
  })

  it('gemini traduz erro HTTP, JSON inválido e resposta vazia', async () => {
    const http = new GeminiProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () => ({ ok: false, status: 429 })) as unknown as typeof fetch,
    })
    await expect(http.generate(request)).rejects.toMatchObject({ code: 'http', message: expect.stringContaining('429') })

    const invalid = new GeminiProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => Promise.reject(new Error('x')) })) as unknown as typeof fetch,
    })
    await expect(invalid.generate(request)).rejects.toMatchObject({ code: 'empty_response' })

    const empty = new GeminiProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () => geminiResponse('')) as unknown as typeof fetch,
    })
    await expect(empty.generate(request)).rejects.toMatchObject({ code: 'empty_response' })
  })

  it('gemini aborta após o timeout', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as unknown as typeof fetch
    const provider = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl, timeoutMs: 10 })
    await expect(provider.generate(request)).rejects.toMatchObject({ code: 'timeout' })
  })
})
