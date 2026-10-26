import type { SVGProps } from 'react'

/** Ícones SVG próprios, traço único de 1.6px — cada um representa uma função, nunca decoração. */
const paths = {
  overview: 'M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-4H4v4Zm10-12h6V4h-6v4Z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  flow: 'M3 17l5-6 4 4 8-9M15 6h5v5',
  signal: 'M12 3v4M12 17v4M4.6 7.5l2.9 2M16.5 14.5l2.9 2M4.6 16.5l2.9-2M16.5 9.5l2.9-2M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  report: 'M7 3h7l5 5v13H7V3Zm7 0v5h5M10 13h6M10 17h6',
  upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-4.3-4.3',
  close: 'M6 6l12 12M18 6 6 18',
  chevronRight: 'm9 6 6 6-6 6',
  chevronLeft: 'm15 6-6 6 6 6',
  arrowRight: 'M5 12h14m-5-5 5 5-5 5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5v-4m0-4h.01',
  alert: 'M12 9v4m0 3.5h.01M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z',
  check: 'm5 12 4.5 4.5L19 7',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4',
  download: 'M12 4v12m0 0-4-4m4 4 4-4M4 20h16',
  menu: 'M4 7h16M4 12h16M4 17h16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  file: 'M7 3h7l5 5v13H7V3Zm7 0v5h5',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3',
  lock: 'M6 11h12v10H6V11Zm2 0V7a4 4 0 1 1 8 0v4',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  calendar: 'M4 6h16v14H4V6Zm0 4h16M8 3v4M16 3v4',
  products: 'M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Zm0 0 8 4.5m0 0 8-4.5M12 13v7',
  reset: 'M4 4v6h6M20 20v-6h-6M5.6 15A7 7 0 0 0 18 17.7M18.4 9A7 7 0 0 0 6 6.3',
} as const

export type IconName = keyof typeof paths

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  )
}

/** Marca: um "N" traçado que termina em um ponto — o sinal que aparece antes do problema. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--color-surface-2)" />
      <path d="M9 23V9l14 14V9" fill="none" stroke="var(--color-ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="23" cy="9" r="2.6" fill="var(--color-pos)" />
    </svg>
  )
}
