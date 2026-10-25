import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useData, useStore } from '@/data/store'
import type { LocalEvent, Product, ProductSale } from '@/domain/types'
import { addDays, formatDateBR, type ISODate } from '@/lib/dates'
import { formatBRL, parseMoney } from '@/lib/money'
import { parseQuantity, formatQuantity } from '@/domain/products/quantity'
import {
  PRODUCT_FIELD_LABELS,
  suggestProductMapping,
  summarizeProductSales,
  validateProductSaleRows,
  type ProductColumnMapping,
  type ProductImportField,
  type ProductSaleRowResult,
} from '@/domain/products/mapping'
import {
  analyzeSeasonality,
  leastSoldProducts,
  productStats,
  rankProducts,
  replenishmentSuggestions,
  staleProducts,
  type ProductStat,
  type ReplenishmentStatus,
} from '@/domain/products/analytics'
import { calendarEvents, upcomingEvents } from '@/domain/products/calendar'
import { generateOpportunities, type Opportunity } from '@/domain/products/opportunities'
import { IMPORT_LIMITS, ImportFileError, sha256Hex, tableFromCSVBytes, toTable, validateFileMeta, type RawTable } from '@/domain/import/pipeline'
import { toCSV } from '@/domain/import/csv'
import { Button, EmptyState, Field, Input, Notice, PageHeader, Panel, Segmented, Select, Tag, cx } from '@/components/ui'
import { Dialog, useToast } from '@/components/overlay'
import { Icon } from '@/components/icons'
import { downloadFile } from '@/lib/hooks'

type Tab = 'visao' | 'reposicao' | 'sazonalidade' | 'catalogo'
const TABS: { value: Tab; label: string }[] = [
  { value: 'visao', label: 'Visão geral' },
  { value: 'reposicao', label: 'Reposição' },
  { value: 'sazonalidade', label: 'Sazonalidade' },
  { value: 'catalogo', label: 'Catálogo' },
]
type RankingMetric = 'revenue' | 'quantity'
const RANKING_OPTIONS: { value: RankingMetric; label: string }[] = [
  { value: 'revenue', label: 'Por faturamento' },
  { value: 'quantity', label: 'Por quantidade' },
]
const MAPPING_FIELDS: ProductImportField[] = ['date', 'product', 'code', 'quantity', 'total', 'unitPrice', 'unitCost', 'stock', 'status', 'externalId']
const STATUS_LABEL: Record<ReplenishmentStatus, { text: string; tone: 'pos' | 'warn' | 'risk' | 'neutral' }> = {
  reorder: { text: 'Repor', tone: 'risk' },
  stale_stock: { text: 'Estoque desatualizado', tone: 'warn' },
  ok: { text: 'Cobertura ok', tone: 'pos' },
  insufficient_data: { text: 'Sem dados', tone: 'neutral' },
}
const OPPORTUNITY_LABEL: Record<Opportunity['kind'], string> = {
  stale: 'Produto parado',
  drop: 'Queda de vendas',
  restock: 'Reposição',
  seasonality: 'Sazonalidade',
  month_start: 'Início do mês',
}

export default function ProductsPage() {
  const data = useData()
  const { actions, today } = useStore()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('visao')
  const [rankingMetric, setRankingMetric] = useState<RankingMetric>('revenue')
  const [sales, setSales] = useState<ProductSale[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Product | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const viewer = data.company.role === 'viewer'
  const from = addDays(today, -89)

  const loadSales = () => {
    setLoadError(null)
    actions
      .listProductSales(from, today)
      .then(setSales)
      .catch(() => setLoadError('Não foi possível carregar as vendas por item.'))
  }

  useEffect(() => {
    let active = true
    setSales(null)
    actions
      .listProductSales(from, today)
      .then((rows) => active && setSales(rows))
      .catch(() => active && setLoadError('Não foi possível carregar as vendas por item.'))
    return () => {
      active = false
    }
  }, [actions, from, today])

  const derived = useMemo(() => {
    const list = sales ?? []
    const stats30 = productStats(data.products, list, addDays(today, -29), today)
    const ranking = rankProducts(data.products, list, today, 30, rankingMetric)
    const leastSold = leastSoldProducts(data.products, list, today, 90)
    const stale = staleProducts(data.products, list, today)
    const replenishment = replenishmentSuggestions(data.products, list, today)
    const seasonality = analyzeSeasonality(list, today)
    const opportunities = generateOpportunities({ products: data.products, sales: list, asOf: today, seasonality })
    const events = calendarEvents(today, addDays(today, 90), data.localEvents)
    const upcoming = upcomingEvents(today, 90, data.localEvents)
    return { list, stats30, ranking, leastSold, stale, replenishment, seasonality, opportunities, events, upcoming }
  }, [data.localEvents, data.products, rankingMetric, sales, today])

  const revenue30 = derived.stats30.reduce((sum, s) => sum + s.revenue, 0)
  const withMargin = derived.stats30.filter((s) => s.margin !== null)
  const margin30 = withMargin.reduce((sum, s) => sum + (s.margin ?? 0), 0)
  const reorder = derived.replenishment.filter((r) => r.needsReorder)
  const statsByProduct = new Map(derived.stats30.map((s) => [s.product.id, s]))

  return (
    <>
      <PageHeader
        meta={<p className="eyebrow">Produtos</p>}
        title="O que vende, o que parou e o que repor"
        description="Leia as vendas por item do seu PDV ou planilha. O Nexo mostra o que sai melhor, margem estimada, produtos parados e sugestões de reposição — sempre com os números que sustentam a sugestão."
        actions={
          <>
            <Button
              icon="download"
              variant="ghost"
              onClick={() =>
                downloadFile(
                  'modelo-vendas-produtos-nexo.csv',
                  toCSV([
                    ['Data', 'Produto', 'Código', 'Quantidade', 'Valor total', 'Custo unitário', 'Estoque atual', 'Situação'],
                    ['20/10/2026', 'Arroz branco 5 kg', 'ARZ5', '3', '83,70', '22,50', '40', 'Concluída'],
                    ['20/10/2026', 'Pão francês', 'PAO1', '2,5', '47,25', '12,90', '8,5', 'Concluída'],
                  ]),
                )
              }
            >
              Baixar modelo CSV
            </Button>
            <Button variant="primary" icon="upload" disabled={viewer} onClick={() => setImportOpen(true)}>
              Importar vendas por item
            </Button>
          </>
        }
      />

      <div className="mb-5">
        <Segmented value={tab} onChange={setTab} options={TABS} label="Seções de produtos" />
      </div>

      {loadError && (
        <Notice tone="risk" title="Vendas indisponíveis" className="mb-5">
          {loadError}{' '}
          <button className="link" onClick={loadSales}>
            Tentar novamente
          </button>
        </Notice>
      )}

      {!sales && !loadError && <div className="mb-5 text-sm text-ink-3">Carregando vendas por item…</div>}

      {tab === 'visao' && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Produtos cadastrados" value={String(data.products.length)} hint={`${derived.ranking.length} venderam nos últimos 30 dias`} />
            <Stat label="Receita em 30 dias" value={formatBRL(revenue30)} hint="Soma das vendas por item no período" />
            <Stat
              label="Margem estimada em 30 dias"
              value={withMargin.length ? formatBRL(margin30) : '—'}
              hint={withMargin.length ? `${withMargin.length} produto(s) com custo informado` : 'Informe o custo dos produtos para calcular'}
            />
            <Stat label="Produtos parados" value={String(derived.stale.length)} hint="0 vendas em 21 dias, mas vendiam antes" />
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
            <Panel
              eyebrow="Mais vendidos"
              title={rankingMetric === 'revenue' ? 'Ranking por faturamento (30 dias)' : 'Ranking por quantidade (30 dias)'}
              actions={<Segmented value={rankingMetric} onChange={setRankingMetric} options={RANKING_OPTIONS} label="Critério do ranking" size="sm" />}
            >
              {derived.ranking.length === 0 ? (
                <EmptyState
                  title="Sem vendas por item ainda"
                  icon="info"
                  action={viewer ? undefined : <Button onClick={() => setImportOpen(true)}>Importar vendas</Button>}
                >
                  Importe a planilha do PDV para ver o ranking dos produtos.
                </EmptyState>
              ) : (
                <RankingTable stats={derived.ranking.slice(0, 8)} />
              )}
            </Panel>

            <Panel eyebrow="Atenção" title="Produtos parados e quedas">
              {derived.stale.length === 0 ? (
                <p className="text-sm text-ink-2">Nenhum produto parado ou com queda forte na janela recente.</p>
              ) : (
                <ul className="space-y-3">
                  {derived.stale.slice(0, 6).map((s) => (
                    <li key={s.product.id} className="rounded-md border border-line-soft px-3 py-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-ink">{s.product.name}</p>
                        <Tag tone={s.reason === 'sharp_drop' ? 'warn' : 'risk'}>{s.reason === 'sharp_drop' ? 'Queda' : 'Parado'}</Tag>
                      </div>
                      <p className="mt-1 text-xs text-ink-2">
                        {s.reason === 'sharp_drop'
                          ? `Caiu ${Math.round(Math.abs(s.dropPct ?? 0))}% frente aos 21 dias anteriores.`
                          : `${s.daysWithoutSale} dias sem vender; antes vendia ${formatQuantity(s.previousQuantity, s.product.unit)} em 21 dias.`}
                      </p>
                      <p className="mt-1 text-xs text-ink-3">Última venda: {s.lastSaleDate ? formatDateBR(s.lastSaleDate) : 'sem registro'}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <Panel eyebrow="Saída baixa" title="Menos vendidos (90 dias)">
            {derived.leastSold.length === 0 ? (
              <p className="text-sm text-ink-2">Cadastre produtos para ver quais saem menos.</p>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {derived.leastSold.slice(0, 6).map((s) => (
                  <li key={s.product.id} className="rounded-md border border-line-soft px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-ink">{s.product.name}</p>
                      {s.quantity === 0 ? <Tag tone="risk">Sem venda</Tag> : <Tag tone="neutral">{formatQuantity(s.quantity, s.product.unit)}</Tag>}
                    </div>
                    <p className="mt-1 text-xs text-ink-2">
                      {s.quantity === 0
                        ? 'Nenhuma venda nos últimos 90 dias.'
                        : `Vendeu ${formatQuantity(s.quantity, s.product.unit)} e faturou ${formatBRL(s.revenue)} em 90 dias.`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel eyebrow="Oportunidades" title="O que pode valer a pena decidir">
            {derived.opportunities.length === 0 ? (
              <p className="text-sm text-ink-2">Sem sugestões no momento. Importe mais histórico para ampliar a leitura.</p>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {derived.opportunities.slice(0, 6).map((o) => (
                  <li key={o.id} className="rounded-md border border-line-soft px-3 py-3">
                    <div className="mb-1 flex items-center gap-2">
                      <Tag tone="accent">{OPPORTUNITY_LABEL[o.kind]}</Tag>
                      <p className="text-sm font-medium text-ink">{o.title}</p>
                    </div>
                    <p className="text-xs leading-relaxed text-ink-2">{o.description}</p>
                    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-ink-3">
                      {o.evidence.map((e) => (
                        <div key={e.label}>
                          <dt className="inline">{e.label}: </dt>
                          <dd className="num inline text-ink-2">{e.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}

      {tab === 'reposicao' && (
        <div className="space-y-5">
          <Notice tone="accent" title="Como a reposição é calculada">
            O estoque informado é ajustado pelas vendas posteriores à data da contagem. A cobertura compara esse saldo com a média diária dos últimos 30 dias e
            com o prazo do fornecedor. A sugestão é uma referência, não uma ordem de compra.
          </Notice>
          <Panel
            eyebrow="Compras"
            title={reorder.length ? `${reorder.length} produto(s) pedem atenção` : 'Cobertura de estoque'}
            actions={<Tag tone={reorder.length ? 'risk' : 'pos'}>{reorder.length ? 'Repor' : 'Sem urgência'}</Tag>}
          >
            {derived.replenishment.length === 0 ? (
              <EmptyState title="Cadastre produtos para calcular a reposição" icon="info" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-line-soft text-left text-2xs uppercase tracking-wide text-ink-3">
                      <th className="py-2 pr-3 font-medium">Produto</th>
                      <th className="py-2 pr-3 font-medium">Estoque estimado</th>
                      <th className="py-2 pr-3 font-medium">Média/dia</th>
                      <th className="py-2 pr-3 font-medium">Cobertura</th>
                      <th className="py-2 pr-3 font-medium">Prazo</th>
                      <th className="py-2 pr-3 font-medium">Sugestão</th>
                      <th className="py-2 font-medium">Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {derived.replenishment.map((r) => {
                      const st = STATUS_LABEL[r.status]
                      return (
                        <tr key={r.product.id} className="border-b border-line-soft/60 last:border-0">
                          <td className="py-2.5 pr-3">
                            <span className="font-medium text-ink">{r.product.name}</span>
                            <span className="ml-1 text-2xs text-ink-3">{r.product.unit}</span>
                          </td>
                          <td className="num py-2.5 pr-3 text-ink-2">{r.stock.estimated === null ? '—' : formatQuantity(r.stock.estimated, r.product.unit)}</td>
                          <td className="num py-2.5 pr-3 text-ink-2">{r.avgDaily > 0 ? formatQuantity(Math.round(r.avgDaily), r.product.unit) : '0'}</td>
                          <td className="num py-2.5 pr-3 text-ink-2">{r.coverageDays === null ? '—' : `${Math.floor(r.coverageDays)} dias`}</td>
                          <td className="num py-2.5 pr-3 text-ink-2">{r.leadTimeDays === null ? '—' : `${r.leadTimeDays} dias`}</td>
                          <td className="num py-2.5 pr-3 text-ink">{r.suggestedQuantity ? formatQuantity(r.suggestedQuantity, r.product.unit) : '—'}</td>
                          <td className="py-2.5">
                            <Tag tone={st.tone}>{st.text}</Tag>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}

      {tab === 'sazonalidade' && (
        <SeasonalityView
          seasonality={derived.seasonality}
          events={derived.events}
          upcoming={derived.upcoming}
          opportunities={derived.opportunities}
          localEvents={data.localEvents}
          viewer={viewer}
          today={today}
          onAddEvent={async (input) => {
            await actions.saveLocalEvent(input)
            toast('Evento local cadastrado')
          }}
        />
      )}

      {tab === 'catalogo' && (
        <Panel
          eyebrow="Catálogo"
          title={`${data.products.length} produto(s)`}
          actions={
            <Button
              variant="primary"
              icon="plus"
              disabled={viewer}
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              Novo produto
            </Button>
          }
        >
          {data.products.length === 0 ? (
            <EmptyState
              title="Nenhum produto cadastrado"
              icon="info"
              action={viewer ? undefined : <Button onClick={() => setFormOpen(true)}>Cadastrar produto</Button>}
            >
              Cadastre manualmente ou importe uma planilha de vendas por item.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-line-soft text-left text-2xs uppercase tracking-wide text-ink-3">
                    <th className="py-2 pr-3 font-medium">Produto</th>
                    <th className="py-2 pr-3 font-medium">Estoque</th>
                    <th className="py-2 pr-3 font-medium">Custo</th>
                    <th className="py-2 pr-3 font-medium">Receita 30d</th>
                    <th className="py-2 pr-3 font-medium">Margem 30d</th>
                    <th className="py-2 pr-3 font-medium">Prazo</th>
                    <th className="py-2 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((p) => {
                    const stat = statsByProduct.get(p.id)
                    const stock = derived.replenishment.find((r) => r.product.id === p.id)?.stock
                    return (
                      <tr key={p.id} className="border-b border-line-soft/60 last:border-0">
                        <td className="py-2.5 pr-3">
                          <span className="font-medium text-ink">{p.name}</span>
                          {p.code && <span className="ml-1.5 text-2xs text-ink-3">{p.code}</span>}
                        </td>
                        <td className="num py-2.5 pr-3 text-ink-2">
                          {stock?.estimated === null || stock === undefined ? '—' : formatQuantity(stock.estimated, p.unit)}
                          {stock?.outdated && <Tag tone="warn">desatualizado</Tag>}
                        </td>
                        <td className="num py-2.5 pr-3 text-ink-2">{p.costPrice === null ? '—' : formatBRL(p.costPrice)}</td>
                        <td className="num py-2.5 pr-3 text-ink-2">{stat ? formatBRL(stat.revenue) : formatBRL(0)}</td>
                        <td className="py-2.5 pr-3">
                          <MarginCell stat={stat} />
                        </td>
                        <td className="num py-2.5 pr-3 text-ink-2">{p.leadTimeDays === null ? '—' : `${p.leadTimeDays} dias`}</td>
                        <td className="py-2.5 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="edit"
                            disabled={viewer}
                            onClick={() => {
                              setEditing(p)
                              setFormOpen(true)
                            }}
                          >
                            Editar
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {formOpen && (
        <ProductFormDialog
          key={editing?.id ?? 'new'}
          product={editing}
          onClose={() => setFormOpen(false)}
          onSave={async (input) => {
            await actions.saveProduct(input)
            toast(editing ? 'Produto atualizado' : 'Produto cadastrado')
            setFormOpen(false)
          }}
        />
      )}

      {importOpen && (
        <ProductImportDialog
          products={data.products}
          sales={derived.list}
          today={today}
          onClose={() => setImportOpen(false)}
          onDone={() => {
            loadSales()
            setImportOpen(false)
          }}
          onImport={async (rows, meta) => {
            await actions.importProductSales(rows, meta)
            toast('Vendas por item importadas')
          }}
        />
      )}
    </>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-line-soft bg-surface px-4 py-3">
      <p className="text-2xs uppercase tracking-wide text-ink-3">{label}</p>
      <p className="num mt-1 text-xl font-semibold text-ink">{value}</p>
      <p className="mt-0.5 text-xs text-ink-3">{hint}</p>
    </div>
  )
}

function MarginCell({ stat }: { stat: ProductStat | undefined }) {
  if (!stat || stat.margin === null) return <span className="text-xs text-ink-3">sem custo</span>
  return (
    <span className="num text-ink-2">
      {formatBRL(stat.margin)} <span className="text-2xs text-ink-3">({Math.round(stat.marginPct ?? 0)}%)</span>
    </span>
  )
}

function RankingTable({ stats }: { stats: ProductStat[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-line-soft text-left text-2xs uppercase tracking-wide text-ink-3">
            <th className="py-2 pr-3 font-medium">#</th>
            <th className="py-2 pr-3 font-medium">Produto</th>
            <th className="py-2 pr-3 font-medium">Quantidade</th>
            <th className="py-2 pr-3 font-medium">Receita</th>
            <th className="py-2 font-medium">Margem</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s, i) => (
            <tr key={s.product.id} className="border-b border-line-soft/60 last:border-0">
              <td className="num py-2.5 pr-3 text-ink-3">{i + 1}</td>
              <td className="py-2.5 pr-3 font-medium text-ink">{s.product.name}</td>
              <td className="num py-2.5 pr-3 text-ink-2">{formatQuantity(s.quantity, s.product.unit)}</td>
              <td className="num py-2.5 pr-3 text-ink-2">{formatBRL(s.revenue)}</td>
              <td className="py-2.5">
                <MarginCell stat={s} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SeasonalityView({
  seasonality,
  events,
  upcoming,
  opportunities,
  localEvents,
  today,
  viewer,
  onAddEvent,
}: {
  seasonality: ReturnType<typeof analyzeSeasonality>
  events: { id: string; name: string; startDate: ISODate; endDate: ISODate | null; kind: LocalEvent['kind'] }[]
  upcoming: ReturnType<typeof upcomingEvents>
  opportunities: Opportunity[]
  localEvents: LocalEvent[]
  today: ISODate
  viewer: boolean
  onAddEvent: (input: { name: string; startDate: ISODate; endDate: ISODate | null; kind: LocalEvent['kind'] }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState('')
  const [kind, setKind] = useState<LocalEvent['kind']>('local')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seasonOpps = opportunities.filter((o) => o.kind === 'seasonality' || o.kind === 'month_start')
  const strongestMonth = seasonality.byMonth.filter((m) => m.index >= 1.1).sort((a, b) => b.index - a.index)[0]
  const strongestWeekday = seasonality.byWeekday.filter((w) => w.index >= 1.1).sort((a, b) => b.index - a.index)[0]

  return (
    <div className="space-y-5">
      <Notice tone="accent" title="Sazonalidade observada no seu histórico">
        {seasonality.sufficient
          ? `Com ${seasonality.historyDays} dias de histórico, os padrões abaixo são uma leitura do faturamento dos seus próprios dados — não uma previsão de venda.`
          : `Ainda há ${seasonality.historyDays} dia(s) de histórico. A partir de 60 dias, o Nexo mostra padrões de faturamento por mês, dia da semana e início do mês.`}
      </Notice>

      <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
        <Panel eyebrow="Padrões" title="Quando o faturamento costuma concentrar">
          {!seasonality.sufficient ? (
            <p className="text-sm text-ink-2">Importe mais histórico de vendas por item para ver os padrões com segurança.</p>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-xs text-ink-3">Início do mês (dias 1 a 10)</p>
                <p className="mt-1 text-sm text-ink">
                  Faturamento médio de <span className="num font-semibold">{formatBRL(seasonality.firstTenAvg)}</span> por dia contra{' '}
                  <span className="num">{formatBRL(seasonality.restAvg)}</span> no resto do mês.
                </p>
                <p className="mt-1 text-sm text-ink-2">
                  Índice <span className="num font-semibold">{seasonality.firstTenIndex === null ? '—' : seasonality.firstTenIndex.toFixed(2)}</span>{' '}
                  <span className="text-ink-3">(1,00 = média do período)</span>
                </p>
              </div>
              {strongestMonth && (
                <p className="text-sm text-ink-2">
                  Em <span className="font-medium text-ink">{strongestMonth.label}</span>, o faturamento médio é{' '}
                  <span className="num">{formatBRL(strongestMonth.avgDaily)}</span> por dia — {Math.round((strongestMonth.index - 1) * 100)}% acima da média
                  diária.
                </p>
              )}
              {strongestWeekday && (
                <p className="text-sm text-ink-2">
                  <span className="font-medium text-ink">{strongestWeekday.label}</span> fatura em média{' '}
                  <span className="num">{formatBRL(strongestWeekday.avgDaily)}</span> por dia — {Math.round((strongestWeekday.index - 1) * 100)}% acima da média
                  diária.
                </p>
              )}
              <div className="grid grid-cols-4 gap-2">
                {seasonality.byWeekday.map((w) => (
                  <div key={w.key} className="rounded border border-line-soft px-2 py-1.5">
                    <p className="text-2xs uppercase text-ink-3">{w.label}</p>
                    <p className="num text-sm text-ink">{w.index.toFixed(2)}</p>
                    <p className="num text-2xs text-ink-3">{formatBRL(w.avgDaily)}/dia</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel eyebrow="Calendário" title="Próximos eventos e datas de apoio">
          {upcoming.length === 0 ? (
            <p className="text-sm text-ink-2">Nenhum evento nos próximos 90 dias.</p>
          ) : (
            <ul className="space-y-2">
              {upcoming.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 border-b border-line-soft/60 pb-2 last:border-0 last:pb-0">
                  <div>
                    <p className="text-sm text-ink">{e.name}</p>
                    <p className="text-xs text-ink-3">
                      {formatDateBR(e.startDate)}
                      {e.endDate && e.endDate !== e.startDate ? ` a ${formatDateBR(e.endDate)}` : ''}
                    </p>
                  </div>
                  <Tag tone={e.kind === 'local' ? 'accent' : e.kind === 'regional' ? 'warn' : 'neutral'}>
                    {e.kind === 'local' ? 'Local' : e.kind === 'regional' ? 'Regional' : 'Nacional'}
                  </Tag>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-ink-3">
            Datas nacionais e regionais são calculadas. Festas da cidade entram apenas se você cadastrar — o Nexo não inventa eventos locais.
          </p>
        </Panel>
      </div>

      <Panel eyebrow="Sugestões" title="Oportunidades de calendário">
        {seasonOpps.length === 0 ? (
          <p className="text-sm text-ink-2">
            Sem sugestões de calendário com histórico suficiente. {events.length > 0 ? 'Os próximos eventos aparecem acima como apoio.' : ''}
          </p>
        ) : (
          <ul className="space-y-3">
            {seasonOpps.map((o) => (
              <li key={o.id} className="rounded-md border border-line-soft px-3 py-2.5">
                <p className="text-sm font-medium text-ink">{o.title}</p>
                <p className="mt-1 text-xs text-ink-2">{o.description}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel eyebrow="Eventos locais" title="Cadastrar festa, feira ou data da cidade">
        {localEvents.length > 0 && (
          <ul className="mb-4 flex flex-wrap gap-2">
            {localEvents.map((e) => (
              <li key={e.id}>
                <Tag tone="accent">
                  {e.name} · {formatDateBR(e.startDate)}
                </Tag>
              </li>
            ))}
          </ul>
        )}
        <form
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
          onSubmit={async (e) => {
            e.preventDefault()
            setError(null)
            if (name.trim().length < 2) {
              setError('Informe o nome do evento.')
              return
            }
            setBusy(true)
            try {
              await onAddEvent({ name: name.trim(), startDate, endDate: endDate || null, kind })
              setName('')
              setEndDate('')
              setKind('local')
            } catch (err) {
              setError(err instanceof Error && err.message ? err.message : 'Não foi possível cadastrar o evento.')
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field label="Nome do evento" htmlFor="event-name">
            <Input
              id="event-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: festejo do padroeiro"
              maxLength={120}
              disabled={viewer}
            />
          </Field>
          <Field label="Início" htmlFor="event-start">
            <Input id="event-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={viewer} />
          </Field>
          <Field label="Fim (opcional)" htmlFor="event-end">
            <Input id="event-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={viewer} />
          </Field>
          <Field label="Tipo" htmlFor="event-kind">
            <Select id="event-kind" value={kind} onChange={(e) => setKind(e.target.value as LocalEvent['kind'])} disabled={viewer}>
              <option value="local">Local</option>
              <option value="regional">Regional</option>
              <option value="national">Nacional</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary" loading={busy} disabled={viewer} className="w-full">
              Adicionar evento
            </Button>
          </div>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-risk">
            {error}
          </p>
        )}
      </Panel>
    </div>
  )
}

function ProductFormDialog({
  product,
  onClose,
  onSave,
}: {
  product: Product | null
  onClose: () => void
  onSave: (input: {
    id?: string
    name: string
    code: string | null
    unit: string
    costPrice: number | null
    stock: number | null
    stockUpdatedAt: ISODate | null
    minStock: number | null
    leadTimeDays: number | null
  }) => Promise<void>
}) {
  const [name, setName] = useState(product?.name ?? '')
  const [code, setCode] = useState(product?.code ?? '')
  const [unit, setUnit] = useState(product?.unit ?? 'un')
  const [cost, setCost] = useState(
    product?.costPrice === null || product?.costPrice === undefined ? '' : (product.costPrice / 100).toFixed(2).replace('.', ','),
  )
  const [stock, setStock] = useState(product?.stock === null || product?.stock === undefined ? '' : formatQuantity(product.stock, ''))
  const [stockDate, setStockDate] = useState(product?.stockUpdatedAt ?? '')
  const [minStock, setMinStock] = useState(product?.minStock === null || product?.minStock === undefined ? '' : formatQuantity(product.minStock, ''))
  const [lead, setLead] = useState(product?.leadTimeDays === null || product?.leadTimeDays === undefined ? '' : String(product.leadTimeDays))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const costCents = cost.trim() ? parseMoney(cost) : null
  const stockMilli = stock.trim() ? parseQuantity(stock) : null
  const minMilli = minStock.trim() ? parseQuantity(minStock) : null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (cost.trim() && costCents === null) return setError('Custo inválido. Use, por exemplo, 22,50.')
    if (stock.trim() && stockMilli === null) return setError('Estoque inválido. Use, por exemplo, 12 ou 2,5.')
    if (minStock.trim() && minMilli === null) return setError('Estoque mínimo inválido.')
    const leadDays = lead.trim() ? Number(lead) : null
    if (leadDays !== null && (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 365))
      return setError('O prazo deve ser um número inteiro entre 0 e 365.')
    setBusy(true)
    try {
      await onSave({
        id: product?.id,
        name,
        code: code.trim() || null,
        unit: unit.trim() || 'un',
        costPrice: costCents,
        stock: stockMilli,
        stockUpdatedAt: stockMilli === null ? null : stockDate || null,
        minStock: minMilli,
        leadTimeDays: leadDays,
      })
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Não foi possível salvar o produto.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={product ? 'Editar produto' : 'Novo produto'}
      description="Custo e estoque ajudam a calcular margem e reposição. Quantidades aceitam casas decimais para produtos vendidos por peso."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="product-form" loading={busy}>
            Salvar
          </Button>
        </>
      }
    >
      <form id="product-form" className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <div className="sm:col-span-2">
          <Field label="Nome" htmlFor="product-name">
            <Input id="product-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
          </Field>
        </div>
        <Field label="Código (opcional)" htmlFor="product-code">
          <Input id="product-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} placeholder="Ex.: ARZ5" />
        </Field>
        <Field label="Unidade" htmlFor="product-unit" hint="un, kg, l…">
          <Input id="product-unit" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={10} />
        </Field>
        <Field label="Custo unitário (R$)" htmlFor="product-cost">
          <Input id="product-cost" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="22,50" />
        </Field>
        <Field label="Estoque atual" htmlFor="product-stock">
          <Input id="product-stock" value={stock} onChange={(e) => setStock(e.target.value)} inputMode="decimal" placeholder="40" />
        </Field>
        <Field label="Data da contagem" htmlFor="product-stock-date" hint="Vendas depois desta data são descontadas.">
          <Input id="product-stock-date" type="date" value={stockDate} onChange={(e) => setStockDate(e.target.value)} />
        </Field>
        <Field label="Estoque mínimo" htmlFor="product-min">
          <Input id="product-min" value={minStock} onChange={(e) => setMinStock(e.target.value)} inputMode="decimal" placeholder="12" />
        </Field>
        <Field label="Prazo do fornecedor (dias)" htmlFor="product-lead">
          <Input id="product-lead" value={lead} onChange={(e) => setLead(e.target.value)} inputMode="numeric" placeholder="10" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-risk sm:col-span-2">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

function ProductImportDialog({
  products,
  sales,
  today,
  onClose,
  onDone,
  onImport,
}: {
  products: Product[]
  sales: ProductSale[]
  today: ISODate
  onClose: () => void
  onDone: () => void
  onImport: (
    rows: NonNullable<ProductSaleRowResult['sale']>[],
    meta: { fileName: string; fileHash: string; totalRows: number; imported: number; skipped: number; errors: number; warnings: number },
  ) => Promise<void>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<{ name: string; hash: string } | null>(null)
  const [table, setTable] = useState<RawTable | null>(null)
  const [mapping, setMapping] = useState<ProductColumnMapping>({})
  const [rows, setRows] = useState<ProductSaleRowResult[] | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const onFile = async (f: File) => {
    setError(null)
    setBusy(true)
    setRows(null)
    try {
      validateFileMeta(f.name, f.size)
      const buf = await f.arrayBuffer()
      const hash = await sha256Hex(buf)
      let parsed: RawTable
      if (f.name.toLowerCase().endsWith('.xlsx')) {
        const { readXlsx, XlsxError } = await import('@/domain/import/xlsx')
        try {
          parsed = toTable(await readXlsx(buf, IMPORT_LIMITS.maxRows))
        } catch (e) {
          if (e instanceof XlsxError) throw new ImportFileError(e.message)
          throw e
        }
      } else parsed = tableFromCSVBytes(new Uint8Array(buf))
      setFile({ name: f.name, hash })
      setTable(parsed)
      setMapping(suggestProductMapping(parsed.headers))
    } catch (e) {
      setError(e instanceof ImportFileError ? e.message : 'Não foi possível ler o arquivo. Verifique se é um CSV ou XLSX válido.')
    } finally {
      setBusy(false)
    }
  }

  const mappingIssues = useMemo(() => {
    const issues: string[] = []
    if (mapping.date === undefined) issues.push('Mapeie a data da venda.')
    if (mapping.product === undefined) issues.push('Mapeie o produto.')
    if (mapping.quantity === undefined) issues.push('Mapeie a quantidade.')
    if (mapping.total === undefined && mapping.unitPrice === undefined) issues.push('Mapeie o valor total ou o valor unitário.')
    return issues
  }, [mapping])

  const summary = rows ? summarizeProductSales(rows) : null
  const issues = rows?.filter((r) => r.errors.length || r.warnings.length).slice(0, 8) ?? []

  return (
    <Dialog
      open
      onClose={onClose}
      title="Importar vendas por item"
      description="CSV ou Excel do PDV. Linhas canceladas, devoluções e valores não positivos são desmarcados com aviso — sem interromper o restante do lote."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          {table && !rows && (
            <Button
              variant="primary"
              onClick={() => setRows(validateProductSaleRows(table, mapping, { products, existing: sales, asOf: today }))}
              disabled={mappingIssues.length > 0}
            >
              Validar planilha
            </Button>
          )}
          {rows && summary && (
            <Button
              variant="primary"
              loading={busy}
              disabled={summary.selected === 0}
              onClick={async () => {
                if (!file) return
                setBusy(true)
                setError(null)
                try {
                  await onImport(
                    rows.filter((r) => r.include && r.sale).map((r) => r.sale!),
                    {
                      fileName: file.name,
                      fileHash: file.hash,
                      totalRows: rows.length,
                      imported: summary.selected,
                      skipped: rows.length - summary.selected - summary.withErrors,
                      errors: summary.withErrors,
                      warnings: summary.withWarnings,
                    },
                  )
                  onDone()
                } catch (e) {
                  setError(e instanceof Error && e.message ? e.message : 'Não foi possível importar as vendas.')
                } finally {
                  setBusy(false)
                }
              }}
            >
              Importar {summary.selected} venda(s)
            </Button>
          )}
        </>
      }
    >
      {!table ? (
        <>
          <label
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const f = e.dataTransfer.files[0]
              if (f) onFile(f)
            }}
            className={cx(
              'flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-6 py-10 text-center transition-colors',
              dragOver ? 'border-accent bg-accent-soft' : 'border-line hover:border-ink-3',
            )}
          >
            <Icon name="upload" size={22} className="mb-3 text-ink-3" />
            <span className="text-sm font-medium text-ink">{busy ? 'Lendo arquivo…' : 'Arraste a planilha aqui ou clique para escolher'}</span>
            <span className="mt-1 text-xs text-ink-3">.csv ou .xlsx · até {IMPORT_LIMITS.maxRows.toLocaleString('pt-BR')} linhas</span>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              aria-label="Arquivo de vendas por item"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onFile(f)
              }}
            />
          </label>
          {error && (
            <Notice tone="risk" title="Arquivo não aceito" className="mt-4">
              {error}
            </Notice>
          )}
          <p className="mt-4 text-xs text-ink-3">
            O arquivo é lido no seu navegador. Se a planilha informar estoque, o cadastro é atualizado com a data mais recente do arquivo.
          </p>
        </>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-2">
              {file?.name} · {table.rows.length} linha(s)
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setTable(null)
                setRows(null)
                setFile(null)
                if (inputRef.current) inputRef.current.value = ''
              }}
            >
              Trocar arquivo
            </Button>
          </div>

          {!rows && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {MAPPING_FIELDS.map((field) => (
                  <Field
                    key={field}
                    label={PRODUCT_FIELD_LABELS[field]}
                    htmlFor={`map-${field}`}
                    hint={field === 'total' || field === 'unitPrice' ? 'Use um dos dois' : undefined}
                  >
                    <Select
                      id={`map-${field}`}
                      value={mapping[field] ?? ''}
                      onChange={(e) => setMapping({ ...mapping, [field]: e.target.value === '' ? undefined : Number(e.target.value) })}
                    >
                      <option value="">— não usar —</option>
                      {table.headers.map((h, i) => (
                        <option key={`${h}-${i}`} value={i}>
                          {h || `Coluna ${i + 1}`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </div>
              {mappingIssues.length > 0 && (
                <Notice tone="warn" title="Faltam colunas">
                  {mappingIssues.join(' ')}
                </Notice>
              )}
            </>
          )}

          {rows && summary && (
            <>
              <div className="flex flex-wrap gap-2 text-xs">
                <Tag tone="neutral">{summary.total} linha(s)</Tag>
                <Tag tone="pos">{summary.selected} a importar</Tag>
                {summary.withWarnings > 0 && <Tag tone="warn">{summary.withWarnings} com aviso</Tag>}
                {summary.withErrors > 0 && <Tag tone="risk">{summary.withErrors} com erro</Tag>}
                {summary.alreadyImported > 0 && <Tag tone="warn">{summary.alreadyImported} já importada(s)</Tag>}
              </div>
              {issues.length > 0 && (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-line-soft p-2 text-xs">
                  {issues.map((r) => (
                    <p key={r.index} className={r.errors.length ? 'text-risk' : 'text-warn'}>
                      Linha {r.index}: {r.errors.length ? r.errors.join('; ') : r.warnings.join('; ')}
                    </p>
                  ))}
                </div>
              )}
              <p className="text-xs text-ink-3">
                A prévia mostra {Math.min(rows.length, 12)} de {rows.length} linhas. Linhas com erro ou já importadas ficam de fora.
              </p>
              <div className="max-h-64 overflow-auto rounded-md border border-line-soft">
                <table className="w-full min-w-[620px] text-xs">
                  <thead className="sticky top-0 bg-surface-2">
                    <tr className="text-left text-ink-3">
                      <th className="px-2 py-1.5 font-medium">Linha</th>
                      <th className="px-2 py-1.5 font-medium">Produto</th>
                      <th className="px-2 py-1.5 font-medium">Data</th>
                      <th className="px-2 py-1.5 font-medium">Quantidade</th>
                      <th className="px-2 py-1.5 font-medium">Receita</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 12).map((r) => (
                      <tr key={r.index} className="border-t border-line-soft/60">
                        <td className="num px-2 py-1.5 text-ink-3">{r.index}</td>
                        <td className={cx('px-2 py-1.5', r.sale ? 'text-ink' : 'text-ink-3')}>{r.sale?.productName ?? '—'}</td>
                        <td className="px-2 py-1.5 text-ink-2">{r.sale ? formatDateBR(r.sale.saleDate) : '—'}</td>
                        <td className="num px-2 py-1.5 text-ink-2">{r.sale ? formatQuantity(r.sale.quantity, '') : '—'}</td>
                        <td className="px-2 py-1.5 text-ink-2">{r.sale ? formatBRL(r.sale.revenue) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {error && (
                <Notice tone="risk" title="Importação não concluída">
                  {error}
                </Notice>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  )
}
