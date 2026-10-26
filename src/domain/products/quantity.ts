/**
 * Quantidades são inteiros em milésimos (1,250 kg = 1250), como o dinheiro em centavos.
 * Conversões usam aritmética de string para não depender de float em nenhuma etapa.
 */
export type MilliQty = number

export const QTY_SCALE = 1000

export function assertMilli(value: number): MilliQty {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Quantidade inválida: ${value}`)
  return value
}

/** Converte "1,250" | "1.25" | 2 em milésimos. Retorna null quando não é reconhecível. */
export function parseQuantity(input: unknown): MilliQty | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    return Math.round(input * QTY_SCALE)
  }
  if (typeof input !== 'string') return null
  let s = input
    .trim()
    .replace(/\u00a0/g, ' ')
    .toLowerCase()
  if (!s) return null
  // Remove unidades comuns depois do número ("1,250 kg", "2 un", "900 ml").
  s = s.replace(/\s*(kg|g|mg|l|ml|un|und|unid|unidade|cx|caixa|pct|pacote|litro|litros)\s*$/i, '')
  s = s.replace(/\s+/g, '')
  if (!s) return null
  let negative = false
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null

  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  let intPart: string
  let fracPart = ''
  if (lastComma >= 0 && lastDot >= 0) {
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
      intPart = a
      fracPart = b
    }
  } else {
    intPart = s
  }
  if (fracPart.length > 3) return null
  if (intPart === '') intPart = '0'
  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) return null
  const milli = Number(intPart) * QTY_SCALE + Number(fracPart.padEnd(3, '0') || '0')
  if (!Number.isSafeInteger(milli)) return null
  return negative ? -milli : milli
}

function validThousands(s: string, sep: string): boolean {
  const groups = s.split(sep)
  if (groups.length === 1) return /^\d+$/.test(groups[0])
  if (!/^\d{1,3}$/.test(groups[0])) return false
  return groups.slice(1).every((g) => /^\d{3}$/.test(g))
}

/** "1.250" vindo do banco NUMERIC(14,3) → 1250. Sem passar por float. */
export function numericToMilli(v: string | number | null): MilliQty {
  if (v === null) return 0
  const s = typeof v === 'number' ? v.toFixed(3) : v
  const m = /^(-?)(\d+)(?:\.(\d{1,3})\d*)?$/.exec(s.trim())
  if (!m) throw new RangeError(`Quantidade numérica inválida do banco: ${s}`)
  const milli = Number(m[2]) * QTY_SCALE + Number((m[3] ?? '').padEnd(3, '0'))
  return m[1] ? -milli : milli
}

/** 1250 → "1.250" (string exata para NUMERIC(14,3)). */
export function milliToNumeric(q: MilliQty): string {
  if (!Number.isSafeInteger(q)) throw new RangeError(`Quantidade inválida: ${q}`)
  const sign = q < 0 ? '-' : ''
  const abs = Math.abs(q)
  return `${sign}${Math.floor(abs / QTY_SCALE)}.${String(abs % QTY_SCALE).padStart(3, '0')}`
}

/** 1250 → "1,25"; 1000 → "1"; 1 → "0,001". */
export function formatQuantity(q: MilliQty, unit?: string): string {
  const sign = q < 0 ? '-' : ''
  const abs = Math.abs(q)
  const int = Math.floor(abs / QTY_SCALE)
  const frac = String(abs % QTY_SCALE)
    .padStart(3, '0')
    .replace(/0+$/, '')
  return `${sign}${int}${frac ? `,${frac}` : ''}${unit ? ` ${unit}` : ''}`
}

export function sumQuantities(values: Iterable<MilliQty>): MilliQty {
  let total = 0
  for (const v of values) total += v
  return assertMilli(total)
}

/** Receita de uma venda = quantidade em milésimos × preço unitário em centavos. */
export function revenueFor(quantity: MilliQty, unitPrice: number): number {
  return Math.round((quantity * unitPrice) / QTY_SCALE)
}
