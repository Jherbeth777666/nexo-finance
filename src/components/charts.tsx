import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatBRL, formatBRLCompact, type Cents } from '@/lib/money'
import { formatDateBR, formatDayMonth, formatMonthLabel } from '@/lib/dates'

/**
 * Gráficos em SVG puro (sem biblioteca de gráficos ≈ 0 KB extra).
 * Recebem dados já agregados — nunca listas brutas de lançamentos.
 */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const start = Math.floor(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max + step * 0.01; v += step) out.push(Math.round(v))
  return out
}

export interface SeriesPoint {
  date: string
  balance: Cents
  inflow?: Cents
  outflow?: Cents
}

export function ProjectionChart({
  points,
  compare,
  compareLabel = 'Comparação',
  primaryLabel = 'Saldo projetado',
  height = 240,
  highlightDate,
  safetyLine,
}: {
  points: SeriesPoint[]
  compare?: SeriesPoint[]
  compareLabel?: string
  primaryLabel?: string
  height?: number
  highlightDate?: string | null
  safetyLine?: Cents
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const clipId = useId().replace(/:/g, '')
  const pad = { top: 12, right: 12, bottom: 24, left: 64 }
  const W = Math.max(width, 280)
  const H = height
  const innerW = W - pad.left - pad.right
  const innerH = H - pad.top - pad.bottom

  const geo = useMemo(() => {
    const all = [...points.map((p) => p.balance), ...(compare?.map((p) => p.balance) ?? []), 0]
    if (safetyLine) all.push(safetyLine)
    const lo = Math.min(...all)
    const hi = Math.max(...all)
    const ticks = niceTicks(lo, hi)
    const yMin = Math.min(ticks[0], lo)
    const yMax = Math.max(ticks[ticks.length - 1], hi)
    const x = (i: number) => pad.left + (points.length <= 1 ? 0 : (i / (points.length - 1)) * innerW)
    const y = (v: number) => pad.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH
    const line = (ps: SeriesPoint[]) => ps.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join('')
    return { ticks, x, y, path: line(points), comparePath: compare ? line(compare) : null, zeroY: y(0) }
  }, [points, compare, innerW, innerH, pad.left, pad.top, safetyLine])

  const xTickIdx = useMemo(() => {
    const n = points.length
    const count = Math.min(n, W < 480 ? 4 : 7)
    return Array.from(new Set(Array.from({ length: count }, (_, k) => Math.round((k * (n - 1)) / Math.max(1, count - 1)))))
  }, [points.length, W])

  if (!points.length) return null
  const hi = highlightDate ? points.findIndex((p) => p.date === highlightDate) : -1
  const hp = hover !== null ? points[hover] : null
  const area = `${geo.path}L${geo.x(points.length - 1)},${geo.zeroY}L${geo.x(0)},${geo.zeroY}Z`
  const minP = points.reduce((m, p) => (p.balance < m.balance ? p : m), points[0])
  const summary = `${primaryLabel}: de ${formatBRL(points[0].balance)} em ${formatDateBR(points[0].date)} a ${formatBRL(points[points.length - 1].balance)} em ${formatDateBR(points[points.length - 1].date)}; menor saldo ${formatBRL(minP.balance)} em ${formatDateBR(minP.date)}.`

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg
        width={W}
        height={H}
        role="img"
        aria-label={summary}
        className="block touch-none"
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const rel = (e.clientX - r.left - pad.left) / innerW
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))))
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={`${clipId}-above`}>
            <rect x={0} y={0} width={W} height={Math.max(0, geo.zeroY)} />
          </clipPath>
          <clipPath id={`${clipId}-below`}>
            <rect x={0} y={geo.zeroY} width={W} height={Math.max(0, H - geo.zeroY)} />
          </clipPath>
        </defs>
        {geo.ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={geo.y(t)}
              y2={geo.y(t)}
              stroke={t === 0 ? '#5a6577' : '#232b37'}
              strokeDasharray={t === 0 ? undefined : '2 4'}
            />
            <text x={pad.left - 8} y={geo.y(t)} dy="0.32em" textAnchor="end" className="num fill-ink-3 text-[10.5px]">
              {formatBRLCompact(t)}
            </text>
          </g>
        ))}
        {safetyLine ? (
          <g>
            <line x1={pad.left} x2={W - pad.right} y1={geo.y(safetyLine)} y2={geo.y(safetyLine)} stroke="#f0b95a" strokeOpacity={0.5} strokeDasharray="6 4" />
            <text x={W - pad.right} y={geo.y(safetyLine) - 5} textAnchor="end" className="fill-warn text-[10px]">
              margem de segurança
            </text>
          </g>
        ) : null}
        <path d={area} fill="#93a8c9" fillOpacity={0.08} clipPath={`url(#${clipId}-above)`} />
        <path d={area} fill="#f07878" fillOpacity={0.14} clipPath={`url(#${clipId}-below)`} />
        {geo.comparePath && <path d={geo.comparePath} fill="none" stroke="#7f8a9b" strokeWidth={1.5} strokeDasharray="4 4" />}
        <path d={geo.path} fill="none" stroke="#c9d5e8" strokeWidth={1.8} clipPath={`url(#${clipId}-above)`} />
        <path d={geo.path} fill="none" stroke="#f07878" strokeWidth={2} clipPath={`url(#${clipId}-below)`} />
        {hi >= 0 && (
          <g>
            <circle
              cx={geo.x(hi)}
              cy={geo.y(points[hi].balance)}
              r={4}
              fill="#101319"
              stroke={points[hi].balance < 0 ? '#f07878' : '#f0b95a'}
              strokeWidth={2}
            />
          </g>
        )}
        {xTickIdx.map((i) => (
          <text
            key={i}
            x={geo.x(i)}
            y={H - 6}
            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
            className="num fill-ink-3 text-[10.5px]"
          >
            {formatDayMonth(points[i].date)}
          </text>
        ))}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={geo.x(hover)} x2={geo.x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="#a4afbf" strokeOpacity={0.35} />
            <circle cx={geo.x(hover)} cy={geo.y(points[hover].balance)} r={3.5} fill="#f1f4f8" />
            {compare?.[hover] && <circle cx={geo.x(hover)} cy={geo.y(compare[hover].balance)} r={3} fill="#7f8a9b" />}
          </g>
        )}
      </svg>
      {hp && hover !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-md border border-line bg-surface-3/95 px-3 py-2 text-xs shadow-lg shadow-black/40"
          style={{ left: Math.min(Math.max(geo.x(hover) + 12, 0), W - 190) }}
        >
          <p className="mb-1 font-medium text-ink">{formatDateBR(hp.date)}</p>
          <p className="flex justify-between gap-4 text-ink-2">
            <span>{primaryLabel}</span>
            <span className={`num ${hp.balance < 0 ? 'text-risk' : 'text-ink'}`}>{formatBRL(hp.balance)}</span>
          </p>
          {compare?.[hover] && (
            <p className="flex justify-between gap-4 text-ink-2">
              <span>{compareLabel}</span>
              <span className="num">{formatBRL(compare[hover].balance)}</span>
            </p>
          )}
          {hp.inflow || hp.outflow ? (
            <p className="mt-1 flex justify-between gap-4 border-t border-line-soft pt-1 text-ink-3">
              <span className="num text-pos">+{formatBRLCompact(hp.inflow ?? 0)}</span>
              <span className="num">−{formatBRLCompact(hp.outflow ?? 0)}</span>
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function MonthlyBars({ data, height = 168 }: { data: { month: string; cashIn: Cents; cashOut: Cents; net: Cents }[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const W = Math.max(width, 260)
  const pad = { top: 8, right: 4, bottom: 22, left: 4 }
  const innerH = height - pad.top - pad.bottom
  const max = Math.max(1, ...data.flatMap((d) => [d.cashIn, d.cashOut]))
  const group = (W - pad.left - pad.right) / data.length
  const bw = Math.min(16, group * 0.28)
  const y = (v: number) => pad.top + innerH - (v / max) * innerH
  const label = data.map((d) => `${formatMonthLabel(d.month)}: entradas ${formatBRL(d.cashIn)}, saídas ${formatBRL(d.cashOut)}`).join('; ')
  return (
    <div ref={ref} className="relative w-full">
      <svg width={W} height={height} role="img" aria-label={`Entradas e saídas por mês. ${label}`} className="block">
        <line x1={pad.left} x2={W - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="#303947" />
        {data.map((d, i) => {
          const cx = pad.left + group * i + group / 2
          const active = hover === i
          return (
            <g key={d.month} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect x={pad.left + group * i} y={pad.top} width={group} height={innerH} fill={active ? '#1d2531' : 'transparent'} />
              <rect x={cx - bw - 1.5} y={y(d.cashIn)} width={bw} height={pad.top + innerH - y(d.cashIn)} rx={2} fill="#57d6a0" fillOpacity={0.75} />
              <rect x={cx + 1.5} y={y(d.cashOut)} width={bw} height={pad.top + innerH - y(d.cashOut)} rx={2} fill="#93a8c9" fillOpacity={0.55} />
              <text x={cx} y={height - 6} textAnchor="middle" className={`text-[10.5px] ${active ? 'fill-ink' : 'fill-ink-3'}`}>
                {formatMonthLabel(d.month)}
              </text>
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border border-line bg-surface-3/95 px-3 py-2 text-xs shadow-lg shadow-black/40"
          style={{ left: Math.min(pad.left + group * hover + group / 2 + 8, W - 180) }}
        >
          <p className="mb-1 font-medium text-ink">{formatMonthLabel(data[hover].month)}</p>
          <p className="flex justify-between gap-4 text-ink-2">
            Entradas <span className="num text-ink">{formatBRL(data[hover].cashIn)}</span>
          </p>
          <p className="flex justify-between gap-4 text-ink-2">
            Saídas <span className="num text-ink">{formatBRL(data[hover].cashOut)}</span>
          </p>
          <p className="mt-1 flex justify-between gap-4 border-t border-line-soft pt-1 text-ink-2">
            Líquido <span className={`num ${data[hover].net < 0 ? 'text-risk' : 'text-pos'}`}>{formatBRL(data[hover].net)}</span>
          </p>
        </div>
      )}
    </div>
  )
}
