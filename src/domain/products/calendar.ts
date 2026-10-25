import type { LocalEvent, LocalEventKind } from '@/domain/types'
import { addDays, daysInMonth, type ISODate } from '@/lib/dates'

/**
 * Calendário de apoio ao comerciante. Festas nacionais/regionais são marcadas como tais e
 * calculadas a partir da Páscoa. Nenhum evento específico de Itapecuru-Mirim é inventado: os
 * eventos da cidade são cadastrados pelo próprio comerciante em `local_events`.
 */

export interface CalendarEvent {
  id: string
  name: string
  startDate: ISODate
  endDate: ISODate | null
  kind: LocalEventKind
  source: 'fixed' | 'local'
}

const iso = (y: number, m: number, d: number): ISODate => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** Domingo de Páscoa (algoritmo gregoriano de Meeus/Jones/Butcher). */
export function easterSunday(year: number): ISODate {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return iso(year, month, day)
}

/** n-ésimo domingo do mês. */
function nthSunday(year: number, month: number, n: number): ISODate {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const first = 1 + ((7 - firstWeekday) % 7)
  return iso(year, month, first + (n - 1) * 7)
}

/** Quarta-feira anterior à 4ª quinta-feira de novembro (Black Friday é a sexta seguinte). */
function blackFriday(year: number): ISODate {
  const firstWeekday = new Date(Date.UTC(year, 10, 1)).getUTCDay()
  const firstThursday = 1 + ((4 - firstWeekday + 7) % 7)
  const fourthThursday = firstThursday + 21
  return addDays(iso(year, 11, fourthThursday), 1)
}

/** Eventos fixos do ano, sem qualquer data específica de Itapecuru-Mirim. */
export function fixedEvents(year: number): CalendarEvent[] {
  const easter = easterSunday(year)
  const events: CalendarEvent[] = [
    { id: `fixed-${year}-pascoa`, name: 'Páscoa', startDate: easter, endDate: null, kind: 'national', source: 'fixed' },
    { id: `fixed-${year}-carnaval`, name: 'Carnaval', startDate: addDays(easter, -47), endDate: addDays(easter, -45), kind: 'national', source: 'fixed' },
    {
      id: `fixed-${year}-maes`,
      name: 'Dia das Mães',
      startDate: nthSunday(year, 5, 2),
      endDate: null,
      kind: 'national',
      source: 'fixed',
    },
    {
      id: `fixed-${year}-saojoao`,
      name: 'São João (junho no Maranhão)',
      startDate: iso(year, 6, 24),
      endDate: iso(year, 6, 30),
      kind: 'regional',
      source: 'fixed',
    },
    { id: `fixed-${year}-volta-aulas-1`, name: 'Volta às aulas', startDate: iso(year, 2, 1), endDate: null, kind: 'regional', source: 'fixed' },
    { id: `fixed-${year}-volta-aulas-2`, name: 'Volta às aulas', startDate: iso(year, 8, 1), endDate: null, kind: 'regional', source: 'fixed' },
    { id: `fixed-${year}-black-friday`, name: 'Black Friday', startDate: blackFriday(year), endDate: null, kind: 'national', source: 'fixed' },
    { id: `fixed-${year}-natal`, name: 'Natal', startDate: iso(year, 12, 25), endDate: null, kind: 'national', source: 'fixed' },
  ]
  for (let m = 1; m <= 12; m++) {
    events.push({
      id: `fixed-${year}-mes-${m}`,
      name: 'Início do mês (contas e salários)',
      startDate: iso(year, m, 1),
      endDate: iso(year, m, Math.min(10, daysInMonth(year, m))),
      kind: 'regional',
      source: 'fixed',
    })
  }
  return events
}

function localToCalendar(e: LocalEvent): CalendarEvent {
  return { id: e.id, name: e.name, startDate: e.startDate, endDate: e.endDate, kind: 'local', source: 'local' }
}

/** Eventos fixos do(s) ano(s) do intervalo + eventos locais cadastrados. */
export function calendarEvents(from: ISODate, to: ISODate, localEvents: LocalEvent[] = []): CalendarEvent[] {
  const firstYear = Number(from.slice(0, 4))
  const lastYear = Number(to.slice(0, 4))
  const fixed: CalendarEvent[] = []
  for (let y = firstYear; y <= lastYear; y++) fixed.push(...fixedEvents(y))
  return [...fixed, ...localEvents.map(localToCalendar)]
    .filter((e) => {
      const end = e.endDate ?? e.startDate
      return end >= from && e.startDate <= to
    })
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name))
}

/** Próximos eventos a partir de `from`, incluindo os que já começaram e ainda estão em curso. */
export function upcomingEvents(from: ISODate, days: number, localEvents: LocalEvent[] = []): CalendarEvent[] {
  return calendarEvents(from, addDays(from, days - 1), localEvents)
}
