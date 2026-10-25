/**
 * Datas de negócio são strings ISO "AAAA-MM-DD" (sem hora), interpretadas no fuso da empresa.
 * Evita o problema clássico de `new Date('2026-01-05')` virar dia 4 no Brasil.
 */
export type ISODate = string

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo'

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false
  const m = ISO_RE.exec(value)
  if (!m) return false
  return isValidYMD(Number(m[1]), Number(m[2]), Number(m[3]))
}

function isValidYMD(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false
  return d <= daysInMonth(y, m)
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function toUTC(date: ISODate): number {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function fromUTC(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10)
}

/** "Hoje" no fuso informado. */
export function todayIn(timeZone = DEFAULT_TIMEZONE, now = new Date()): ISODate {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromUTC(toUTC(date) + days * 86_400_000)
}

/** Soma meses preservando o dia quando possível (31/01 + 1 mês → último dia de fevereiro). */
export function addMonths(date: ISODate, months: number): ISODate {
  const [y, m, d] = date.split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const nd = Math.min(d, daysInMonth(ny, nm))
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`
}

/** a − b em dias. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(a) - toUTC(b)) / 86_400_000)
}

export function isWithin(date: ISODate, start: ISODate, end: ISODate): boolean {
  return date >= start && date <= end
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b
}

export function weekday(date: ISODate): number {
  return new Date(toUTC(date)).getUTCDay()
}

export function formatDateBR(date: ISODate | null | undefined): string {
  if (!date) return '—'
  const [y, m, d] = date.split('-')
  return `${d}/${m}/${y}`
}

const monthShort = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

export function formatDayMonth(date: ISODate): string {
  const [, m, d] = date.split('-')
  return `${d}/${m}`
}

export function formatMonthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-')
  return `${monthShort[Number(m) - 1]}/${y.slice(2)}`
}

const weekdayShort = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
export function formatWeekday(date: ISODate): string {
  return weekdayShort[weekday(date)]
}

/**
 * Converte datas comuns em planilhas brasileiras para ISO.
 * Aceita DD/MM/AAAA, DD-MM-AAAA, DD.MM.AAAA, DD/MM/AA, AAAA-MM-DD, AAAA/MM/DD
 * e números seriais do Excel. Formato americano MM/DD não é aceito: datas como 13/25/2026 são rejeitadas.
 */
export function parseDateFlexible(input: unknown): ISODate | null {
  if (typeof input === 'number') return excelSerialToISO(input)
  if (typeof input !== 'string') return null
  const s = input.trim().split(/[ T]/)[0]
  if (!s) return null
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s)
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s)
  if (m) {
    let y = Number(m[3])
    if (m[3].length === 2) y += y >= 70 ? 1900 : 2000
    return build(y, Number(m[2]), Number(m[1]))
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return excelSerialToISO(Number(s))
  return null
}

function build(y: number, m: number, d: number): ISODate | null {
  if (!isValidYMD(y, m, d)) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Serial do Excel (sistema 1900). Faixa aceita: 1950–2150, para não confundir valores com datas. */
export function excelSerialToISO(serial: number): ISODate | null {
  if (!Number.isFinite(serial) || serial < 18264 || serial > 91310) return null
  return fromUTC(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000)
}
