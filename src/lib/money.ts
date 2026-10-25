/**
 * Dinheiro é sempre representado em centavos inteiros (number) no cliente.
 * No banco, NUMERIC(14,2). Nunca somar floats de reais diretamente.
 */
export type Cents = number

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const brlCompact = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function assertCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Valor monetário inválido: ${value}`)
  return value
}

export function formatBRL(cents: Cents): string {
  return brl.format(cents / 100)
}

export function formatBRLCompact(cents: Cents): string {
  return brlCompact.format(cents / 100)
}

/** Valor com sinal explícito (+/−), útil para variações. */
export function formatSignedBRL(cents: Cents): string {
  if (cents === 0) return formatBRL(0)
  const sign = cents > 0 ? '+' : '−'
  return `${sign}${formatBRL(Math.abs(cents))}`
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0
  for (const v of values) total += v
  return assertCents(total)
}

/** Aplica percentual a centavos com arredondamento meio-para-par. */
export function applyPercent(cents: Cents, percent: number): Cents {
  const raw = (cents * percent) / 100
  const floor = Math.floor(raw)
  const diff = raw - floor
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1
  return Math.round(raw)
}

/** Variação percentual; null quando a base é zero (não há comparação possível). */
export function percentChange(current: Cents, base: Cents): number | null {
  if (base === 0) return null
  return ((current - base) / Math.abs(base)) * 100
}

/**
 * Converte texto monetário em centavos. Aceita formatos brasileiros e internacionais:
 * "1.250,50", "1250,50", "1250.50", "1,250.50", "R$ -1.250,50", "(1.250,50)", "-R$ 10".
 * Retorna null quando o texto não é um valor reconhecível (nunca adivinha).
 */
export function parseMoney(input: unknown): Cents | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    return Math.round(input * 100)
  }
  if (typeof input !== 'string') return null
  let s = input.trim().replace(/\u00a0/g, ' ')
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  if (/\d\s+\d/.test(s)) return null
  s = s.replace(/\s+/g, '')
  if ((s.match(/-/g) ?? []).length > 1) return null
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  } else if (s.endsWith('-')) {
    negative = !negative
    s = s.slice(0, -1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }
  s = s.replace(/^R\$/i, '')
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null

  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  let intPart: string
  let fracPart = ''
  if (lastComma >= 0 && lastDot >= 0) {
    // O separador que aparece por último é o decimal.
    const decIdx = Math.max(lastComma, lastDot)
    const thousandSep = decIdx === lastComma ? '.' : ','
    intPart = s.slice(0, decIdx)
    fracPart = s.slice(decIdx + 1)
    if (!validThousands(intPart, thousandSep)) return null
    intPart = intPart.split(thousandSep).join('')
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.'
    const parts = s.split(sep)
    if (parts.length > 2) {
      if (!validThousands(s, sep)) return null
      intPart = parts.join('')
    } else {
      const [a, b] = parts
      // "1.250" é ambíguo: ponto seguido de exatamente 3 dígitos é tratado como milhar (padrão BR).
      // Vírgula é sempre decimal (padrão BR).
      if (sep === '.' && b.length === 3 && a.length > 0 && a !== '0') {
        intPart = a + b
      } else {
        intPart = a
        fracPart = b
      }
    }
  } else {
    intPart = s
  }
  if (fracPart.length > 2) return null
  if (intPart === '') intPart = '0'
  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) return null
  const cents = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0') || '0')
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}

function validThousands(s: string, sep: string): boolean {
  const groups = s.split(sep)
  if (groups.length === 1) return /^\d+$/.test(groups[0])
  if (!/^\d{1,3}$/.test(groups[0])) return false
  return groups.slice(1).every((g) => /^\d{3}$/.test(g))
}
