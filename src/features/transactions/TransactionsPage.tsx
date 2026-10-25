import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { Transaction } from '@/domain/types'
import { KIND_LABEL, TX_VIEW_LABELS, statusLabel, viewPredicate, type TxView } from '@/domain/transactions'
import { useData, useStore } from '@/data/store'
import { useAlerts, useCategoryMap } from '@/data/useFinance'
import { Button, EmptyState, Input, Money, PageHeader, Select, Tag, cx } from '@/components/ui'
import { Icon } from '@/components/icons'
import { addDays, formatDateBR } from '@/lib/dates'
import { useDebounced, useSlashFocus } from '@/lib/hooks'
import { norm } from '@/domain/import/pipeline'
import { TransactionDialog } from './TransactionDialog'

const PAGE = 25
type Period = 'all' | 'month' | 'last30' | 'next30' | 'custom'
type Basis = 'dueDate' | 'competenceDate' | 'settledDate'
type StatusFilter = 'all' | 'pending' | 'overdue' | 'settled' | 'cancelled'

export default function TransactionsPage() {
  const data = useData()
  const { today } = useStore()
  const catMap = useCategoryMap()
  const { alerts } = useAlerts()
  const [params, setParams] = useSearchParams()
  const searchRef = useRef<HTMLInputElement>(null)
  useSlashFocus(searchRef)

  const view = (params.get('visao') as TxView | null) ?? 'all'
  const alertFp = params.get('alerta')
  const linkedAlert = alertFp ? alerts.find((a) => a.fingerprint === alertFp) : null

  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [period, setPeriod] = useState<Period>('all')
  const [basis, setBasis] = useState<Basis>('dueDate')
  const [from, setFrom] = useState(addDays(today, -30))
  const [to, setTo] = useState(today)
  const [kind, setKind] = useState<'all' | Transaction['kind']>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [category, setCategory] = useState('all')
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    if (params.get('novo') === '1') {
      setEditing(null)
      setDialogOpen(true)
      params.delete('novo')
      setParams(params, { replace: true })
    }
  }, [params, setParams])

  const filtered = useMemo(() => {
    const range: [string, string] | null =
      period === 'month'
        ? [`${today.slice(0, 7)}-01`, `${today.slice(0, 7)}-31`]
        : period === 'last30'
          ? [addDays(today, -29), today]
          : period === 'next30'
            ? [today, addDays(today, 29)]
            : period === 'custom'
              ? [from, to]
              : null
    const viewPred = viewPredicate(view, today)
    const idSet = linkedAlert ? new Set(linkedAlert.transactionIds) : null
    const needle = norm(dq)
    return data.transactions
      .filter((t) => {
        if (idSet && !idSet.has(t.id)) return false
        if (!viewPred(t)) return false
        if (kind !== 'all' && t.kind !== kind) return false
        if (status === 'pending' && t.status !== 'pending') return false
        if (status === 'overdue' && !(t.status === 'pending' && t.dueDate < today)) return false
        if (status === 'settled' && t.status !== 'settled') return false
        if (status === 'cancelled' && t.status !== 'cancelled') return false
        if (category !== 'all' && (category === 'none' ? t.categoryId !== null || t.kind === 'transfer' : t.categoryId !== category)) return false
        if (range) {
          const d = t[basis]
          if (!d || d < range[0] || d > range[1]) return false
        }
        if (needle) {
          const hay = norm(`${t.description} ${t.counterparty ?? ''} ${t.notes ?? ''} ${catMap.get(t.categoryId ?? '')?.name ?? ''}`)
          if (!hay.includes(needle)) return false
        }
        return true
      })
      .sort((a, b) => (b[basis] ?? b.dueDate).localeCompare(a[basis] ?? a.dueDate) || b.amount - a.amount)
  }, [data.transactions, period, today, from, to, view, linkedAlert, dq, kind, status, category, basis, catMap])

  useEffect(() => setPage(0), [filtered.length, dq, kind, status, category, period])

  const totals = useMemo(() => {
    let inc = 0
    let exp = 0
    for (const t of filtered) {
      if (t.status === 'cancelled') continue
      if (t.kind === 'income') inc += t.amount
      else if (t.kind === 'expense') exp += t.amount
    }
    return { inc, exp }
  }, [filtered])

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const rows = filtered.slice(page * PAGE, page * PAGE + PAGE)
  const hasFilters = q || period !== 'all' || kind !== 'all' || status !== 'all' || category !== 'all'

  const clearContext = () => {
    params.delete('visao')
    params.delete('alerta')
    setParams(params, { replace: true })
  }
  const clearAll = () => {
    setQ('')
    setPeriod('all')
    setKind('all')
    setStatus('all')
    setCategory('all')
    clearContext()
  }

  return (
    <>
      <PageHeader
        meta={<p className="eyebrow">Movimentações</p>}
        title="Lançamentos"
        description="Receitas, despesas, contas a pagar e a receber e transferências entre contas próprias."
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            Novo lançamento
          </Button>
        }
      />

      {(view !== 'all' || alertFp) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-accent/25 bg-accent-soft px-3 py-2 text-sm">
          <Icon name="eye" size={16} className="text-accent" />
          <span className="text-ink-2">Exibindo:</span>
          <span className="font-medium text-ink">
            {alertFp
              ? linkedAlert
                ? `lançamentos que sustentam "${linkedAlert.title}"`
                : 'alerta não encontrado (pode ter sido resolvido pelos dados)'
              : TX_VIEW_LABELS[view]}
          </span>
          <button onClick={clearContext} className="link ml-auto text-xs">
            Remover
          </button>
        </div>
      )}

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1.4fr)_repeat(4,minmax(0,1fr))]">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
          <Input
            ref={searchRef}
            type="search"
            placeholder="Buscar descrição, cliente, categoria…"
            aria-label="Buscar lançamentos"
            className="pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border border-line px-1.5 text-2xs text-ink-3 sm:block">
            /
          </kbd>
        </div>
        <Select aria-label="Período" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
          <option value="all">Todo o período</option>
          <option value="month">Mês atual</option>
          <option value="last30">Últimos 30 dias</option>
          <option value="next30">Próximos 30 dias</option>
          <option value="custom">Personalizado…</option>
        </Select>
        <Select aria-label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="all">Todos os tipos</option>
          <option value="income">Receitas</option>
          <option value="expense">Despesas</option>
          <option value="transfer">Transferências</option>
        </Select>
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="all">Todas as situações</option>
          <option value="pending">Pendentes</option>
          <option value="overdue">Vencidos</option>
          <option value="settled">Liquidados</option>
          <option value="cancelled">Cancelados</option>
        </Select>
        <Select aria-label="Categoria" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">Todas as categorias</option>
          <option value="none">Sem categoria</option>
          {data.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      {period !== 'all' && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-3">Filtrar pela data de</span>
          <Select aria-label="Data usada no filtro" value={basis} onChange={(e) => setBasis(e.target.value as Basis)} className="w-auto py-1.5">
            <option value="dueDate">vencimento</option>
            <option value="competenceDate">competência</option>
            <option value="settledDate">liquidação</option>
          </Select>
          {period === 'custom' && (
            <>
              <Input type="date" aria-label="De" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto py-1.5" />
              <span className="text-ink-3">até</span>
              <Input type="date" aria-label="Até" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto py-1.5" />
            </>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line-soft bg-surface">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-line-soft px-4 py-2.5 text-xs text-ink-3 sm:px-5">
          <span>
            <span className="num text-ink">{filtered.length}</span> lançamento(s)
          </span>
          <span>
            Receitas <Money value={totals.inc} className="text-ink-2" />
          </span>
          <span>
            Despesas <Money value={totals.exp} className="text-ink-2" />
          </span>
          <span className="text-2xs">Cancelados e transferências fora dos totais</span>
          {hasFilters && (
            <button onClick={clearAll} className="link ml-auto">
              Limpar filtros
            </button>
          )}
        </div>
        {rows.length === 0 ? (
          <EmptyState
            title={data.transactions.length ? 'Nenhum lançamento com esses filtros' : 'Nenhum lançamento ainda'}
            icon="search"
            action={hasFilters || view !== 'all' ? <Button onClick={clearAll}>Limpar filtros</Button> : undefined}
          >
            {data.transactions.length ? 'Ajuste a busca ou o período.' : 'Crie um lançamento ou importe uma planilha.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-line-soft text-left text-2xs tracking-wider text-ink-3 uppercase">
                  <th scope="col" className="px-4 py-2.5 font-medium sm:px-5">
                    {basis === 'competenceDate' ? 'Competência' : basis === 'settledDate' ? 'Liquidação' : 'Vencimento'}
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    Descrição
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    Situação
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium sm:px-5">
                    Valor
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {rows.map((t) => {
                  const st = statusLabel(t, today)
                  const cat = t.categoryId ? catMap.get(t.categoryId)?.name : null
                  const d = t[basis] ?? t.dueDate
                  return (
                    <tr
                      key={t.id}
                      tabIndex={0}
                      onClick={() => {
                        setEditing(t)
                        setDialogOpen(true)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setEditing(t)
                          setDialogOpen(true)
                        }
                      }}
                      className={cx(
                        'cursor-pointer transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2',
                        t.status === 'cancelled' && 'opacity-55',
                      )}
                      aria-label={`${t.description}, ${st}, editar`}
                    >
                      <td className="num px-4 py-2.5 whitespace-nowrap text-ink-2 sm:px-5">{formatDateBR(d)}</td>
                      <td className="max-w-0 px-3 py-2.5">
                        <p className="truncate text-ink">{t.description}</p>
                        <p className="truncate text-xs text-ink-3">
                          {[t.kind === 'transfer' ? KIND_LABEL.transfer : (cat ?? 'Sem categoria'), t.counterparty].filter(Boolean).join(' · ')}
                        </p>
                      </td>
                      <td className="px-3 py-2.5">
                        <Tag tone={st === 'Vencido' ? 'warn' : t.status === 'settled' ? 'neutral' : t.status === 'cancelled' ? 'neutral' : 'accent'}>{st}</Tag>
                      </td>
                      <td className="px-4 py-2.5 text-right sm:px-5">
                        <Money
                          value={t.kind === 'expense' ? -t.amount : t.amount}
                          signed={t.kind !== 'transfer'}
                          className={cx(
                            t.kind === 'income' ? 'text-pos' : t.kind === 'transfer' ? 'text-ink-3' : 'text-ink',
                            t.status === 'cancelled' && 'line-through',
                          )}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <nav aria-label="Paginação" className="flex items-center justify-between border-t border-line-soft px-4 py-2.5 text-xs text-ink-3 sm:px-5">
            <span>
              Página <span className="num text-ink">{page + 1}</span> de <span className="num">{pages}</span>
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" icon="chevronLeft" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </Button>
              <Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
                Próxima
                <Icon name="chevronRight" size={14} />
              </Button>
            </div>
          </nav>
        )}
      </div>

      <TransactionDialog open={dialogOpen} tx={editing} onClose={() => setDialogOpen(false)} />
    </>
  )
}
