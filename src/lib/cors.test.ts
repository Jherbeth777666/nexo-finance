import { matchAllowedOrigin, parseAllowedOrigins } from './cors'

describe('origens permitidas das Edge Functions', () => {
  const raw = 'http://localhost:5173, https://zippy-biscuit-ebc7d7.netlify.app/ '

  it('aceita lista separada por vírgula, sem espaços nem barra final', () => {
    expect(parseAllowedOrigins(raw)).toEqual(['http://localhost:5173', 'https://zippy-biscuit-ebc7d7.netlify.app'])
  })

  it('devolve exatamente a origem que bateu, para cada item da lista', () => {
    const allowed = parseAllowedOrigins(raw)
    expect(matchAllowedOrigin(allowed, 'http://localhost:5173')).toBe('http://localhost:5173')
    expect(matchAllowedOrigin(allowed, 'https://zippy-biscuit-ebc7d7.netlify.app')).toBe('https://zippy-biscuit-ebc7d7.netlify.app')
  })

  it('recusa origem fora da lista, inclusive parecidas', () => {
    const allowed = parseAllowedOrigins(raw)
    for (const o of ['https://evil.netlify.app', 'https://zippy-biscuit-ebc7d7.netlify.app.evil.com', 'http://localhost:5174', 'https://localhost:5173']) {
      expect(matchAllowedOrigin(allowed, o), o).toBeNull()
    }
    expect(matchAllowedOrigin(allowed, null)).toBeNull()
  })

  it('lista vazia, ausente ou só com "*" falha fechada', () => {
    for (const r of [undefined, null, '', ' , ', '*']) {
      const allowed = parseAllowedOrigins(r)
      expect(allowed, String(r)).toEqual([])
      expect(matchAllowedOrigin(allowed, 'http://localhost:5173')).toBeNull()
    }
  })
})
