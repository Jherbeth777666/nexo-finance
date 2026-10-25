import { Skeleton } from '@/components/ui'

/** Skeleton leve com a mesma geometria das páginas, para não causar deslocamento de layout. */
export function PageFallback({ full }: { full?: boolean }) {
  return (
    <div className={full ? 'min-h-screen bg-bg p-6' : ''} aria-busy="true" aria-label="Carregando">
      <Skeleton className="mb-2 h-3 w-24" />
      <Skeleton className="mb-6 h-7 w-56" />
      <Skeleton className="mb-4 h-28 w-full" />
      <div className="grid gap-4 lg:grid-cols-5">
        <Skeleton className="h-64 lg:col-span-3" />
        <Skeleton className="h-64 lg:col-span-2" />
      </div>
    </div>
  )
}
