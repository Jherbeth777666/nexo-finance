import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { Link, type LinkProps } from 'react-router'
import { formatBRL, formatSignedBRL, type Cents } from '@/lib/money'
import type { AlertSeverity } from '@/domain/types'
import { Icon, type IconName } from './icons'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-bg font-semibold hover:bg-accent/90 hover:brightness-110 max-sm:min-h-11',
  secondary: 'border border-line bg-surface-2 text-ink hover:border-ink-3/70 hover:bg-surface-3',
  ghost: 'text-ink-2 hover:text-ink hover:bg-surface-2',
  danger: 'bg-risk/90 text-bg hover:bg-risk font-semibold',
}
const sizes = { sm: 'min-h-9 px-3 text-xs gap-1.5', md: 'min-h-10 px-3.5 text-sm gap-2' }

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: keyof typeof sizes
  icon?: IconName
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex items-center justify-center rounded-md whitespace-nowrap transition-colors active:scale-[0.99] disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  )
})

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: LinkProps & { variant?: Variant; size?: keyof typeof sizes; icon?: IconName }) {
  return (
    <Link
      className={cx(
        'inline-flex items-center justify-center rounded-md whitespace-nowrap transition-colors active:scale-[0.99]',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </Link>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className)} width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  )
}

/** Valor monetário com números tabulares. `tone="auto"` colore apenas pelo sinal. */
export function Money({
  value,
  signed,
  tone = 'none',
  className,
}: {
  value: Cents
  signed?: boolean
  tone?: 'none' | 'auto' | 'risk-only'
  className?: string
}) {
  const color = tone === 'auto' ? (value > 0 ? 'text-pos' : value < 0 ? 'text-risk' : '') : tone === 'risk-only' && value < 0 ? 'text-risk' : ''
  return <span className={cx('num whitespace-nowrap', color, className)}>{signed ? formatSignedBRL(value) : formatBRL(value)}</span>
}

const sevStyles: Record<AlertSeverity, { label: string; cls: string; bar: string }> = {
  critical: { label: 'Crítico', cls: 'text-risk bg-risk-soft', bar: 'bg-risk' },
  warning: { label: 'Atenção', cls: 'text-warn bg-warn-soft', bar: 'bg-warn' },
  info: { label: 'Informativo', cls: 'text-accent bg-accent-soft', bar: 'bg-accent' },
}
export const severityBar = (s: AlertSeverity) => sevStyles[s].bar

export function SeverityTag({ severity }: { severity: AlertSeverity }) {
  const s = sevStyles[severity]
  return <span className={cx('inline-flex items-center rounded-sm px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide', s.cls)}>{s.label}</span>
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'pos' | 'warn' | 'risk' | 'accent' }) {
  const tones = {
    neutral: 'text-ink-2 bg-surface-3',
    pos: 'text-pos bg-pos-soft',
    warn: 'text-warn bg-warn-soft',
    risk: 'text-risk bg-risk-soft',
    accent: 'text-accent bg-accent-soft',
  }
  return <span className={cx('inline-flex items-center rounded-sm px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap', tones[tone])}>{children}</span>
}

/** Região de conteúdo. Diferente de "card": tem cabeçalho editorial e borda de 1px, sem sombra. */
export function Panel({
  eyebrow,
  title,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  eyebrow?: string
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  id?: string
}) {
  const headingId = useId()
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cx('rounded-lg border border-line-soft bg-surface bg-gradient-to-b from-white/[0.02] to-transparent shadow-card', className)}
    >
      {(title || eyebrow || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {eyebrow && <p className="eyebrow mb-0.5">{eyebrow}</p>}
            {title && (
              <h2 id={headingId} className="text-base font-semibold text-ink">
                {title}
              </h2>
            )}
          </div>
          {actions && <div className="flex min-w-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('p-4 sm:p-5', bodyClassName)}>{children}</div>
    </section>
  )
}

/** Definição de indicador acessível: botão que revela o texto (não depende de hover). */
export function Definition({ text, label = 'Ver definição' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className="inline-flex h-6 w-6 -m-1 items-center justify-center rounded-full text-ink-3 hover:text-ink"
      >
        <Icon name="info" size={13} />
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className="absolute top-6 left-1/2 z-30 w-64 -translate-x-1/2 rounded-md border border-line bg-surface-3 p-3 text-left text-xs leading-relaxed font-normal normal-case tracking-normal text-ink-2 shadow-xl shadow-black/40"
        >
          {text}
        </span>
      )}
    </span>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden="true" />
}

export function EmptyState({ title, children, action, icon = 'info' }: { title: string; children?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md bg-surface-2 text-ink-3">
        <Icon name={icon} />
      </span>
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Notice({
  tone = 'accent',
  title,
  children,
  className,
}: {
  tone?: 'accent' | 'warn' | 'risk' | 'pos'
  title?: string
  children: ReactNode
  className?: string
}) {
  const tones = {
    accent: 'border-accent/30 bg-accent-soft',
    warn: 'border-warn/30 bg-warn-soft',
    risk: 'border-risk/35 bg-risk-soft',
    pos: 'border-pos/30 bg-pos-soft',
  }
  const icon: Record<string, IconName> = { accent: 'info', warn: 'alert', risk: 'alert', pos: 'check' }
  const iconColor = { accent: 'text-accent', warn: 'text-warn', risk: 'text-risk', pos: 'text-pos' }
  return (
    <div role={tone === 'risk' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-md border px-3.5 py-3 text-sm', tones[tone], className)}>
      <Icon name={icon[tone]} className={cx('mt-0.5 shrink-0', iconColor[tone])} />
      <div className="min-w-0 text-ink-2">
        {title && <p className="mb-0.5 font-medium text-ink">{title}</p>}
        {children}
      </div>
    </div>
  )
}

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-ink-2">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1 text-xs text-risk">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1 text-xs text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { invalid, className, id, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      id={id}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid && id ? `${id}-error` : undefined}
      className={cx('field', className)}
      {...rest}
    />
  )
})

export function Select({ invalid, className, id, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      id={id}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid && id ? `${id}-error` : undefined}
      className={cx('field pr-8', className)}
      {...rest}
    >
      {children}
    </select>
  )
}

/** Controle segmentado com semântica de grupo de rádio. */
export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; count?: number }[]
  label: string
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('inline-flex max-w-full overflow-x-auto rounded-md border border-line bg-surface-2 p-0.5', className)}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-label={o.count ? `${o.label} (${o.count})` : o.label}
            aria-checked={active}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const idx = options.findIndex((x) => x.value === value)
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const next = options[(idx + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]
                onChange(next.value)
              }
            }}
            tabIndex={active ? 0 : -1}
            className={cx(
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors focus-visible:outline-offset-0',
              size === 'sm' ? 'min-h-7 px-2 py-1 text-xs' : 'min-h-9 px-3 py-1.5 text-xs sm:text-sm',
              active ? 'border-line/80 bg-surface-3 text-ink shadow-sm shadow-black/30' : 'border-transparent text-ink-3 hover:text-ink',
            )}
          >
            {o.label}
            {o.count ? (
              <span
                className={cx(
                  'inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold',
                  active ? 'bg-accent/15 text-accent' : 'bg-surface-3 text-ink-2',
                )}
              >
                {o.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function PageHeader({ title, description, actions, meta }: { title: string; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {meta && <div className="mb-1.5">{meta}</div>}
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
