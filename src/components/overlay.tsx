import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, cx } from './ui'
import { Icon } from './icons'

/**
 * Diálogo modal sobre o elemento nativo <dialog>: foco preso, Esc e acessibilidade
 * do próprio navegador, sem biblioteca.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal?.()
    if (!open && d.open) d.close()
  }, [open])
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' }
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      aria-labelledby="dialog-title"
      className={cx(
        'm-auto w-[calc(100%-2rem)] rounded-lg border border-line bg-surface p-0 text-ink shadow-2xl shadow-black/60 backdrop:bg-black/70',
        widths[size],
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-4">
            <div>
              <h2 id="dialog-title" className="text-base font-semibold">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-ink-2">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Fechar">
              <Icon name="close" />
            </button>
          </header>
          {children && <div className="overflow-y-auto px-5 py-4">{children}</div>}
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line-soft px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  )
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirmar',
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog
      open={open}
      onClose={() => {
        setError(null)
        onClose()
      }}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await onConfirm()
                onClose()
              } catch (e) {
                setError(e instanceof Error && e.message ? e.message : 'Não foi possível concluir a ação.')
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-2">{description}</p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-risk">
          {error}
        </p>
      )}
    </Dialog>
  )
}

type ToastTone = 'pos' | 'risk' | 'accent'
interface ToastItem {
  id: number
  message: string
  tone: ToastTone
}
const ToastCtx = createContext<(message: string, tone?: ToastTone) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((message: string, tone: ToastTone = 'pos') => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x.slice(-2), { id, message, tone }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4200)
  }, [])
  const dot = { pos: 'bg-pos', risk: 'bg-risk', accent: 'bg-accent' }
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed right-4 bottom-20 z-50 flex flex-col items-end gap-2 lg:bottom-6">
        {items.map((t) => (
          <div key={t.id} className="pointer-events-auto flex items-center gap-2.5 rounded-md border border-line bg-surface-3 px-3.5 py-2.5 text-sm text-ink shadow-xl shadow-black/40">
            <span className={cx('h-1.5 w-1.5 rounded-full', dot[t.tone])} />
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)
