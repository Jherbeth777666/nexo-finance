import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useAlerts, useOverview } from '@/data/useFinance'
import { useData } from '@/data/store'
import { METRIC_DEFINITIONS } from '@/domain/finance/metrics'
import { BASE_SCENARIO, projectCashflow } from '@/domain/finance/projection'
import { Button, ButtonLink, Definition, EmptyState, Money, PageHeader, Panel, SeverityTag, cx, severityBar } from '@/components/ui'
import { Icon } from '@/components/icons'
import { MonthlyBars, ProjectionChart } from '@/components/charts'
import { addDays, formatDateBR, formatMonthLabel } from '@/lib/dates'
import { formatBRL } from '@/lib/money'

const ALERT_ICON = { critical: 'alert', warning: 'alert', info: 'info' } as const
const ALERT_ICON_TONE = { critical: 'text-risk', warning: 'text-warn', info: 'text-accent' } as const

export default function OverviewPage() {
  const o = useOverview()
  const { open } = useAlerts()
  const [showAllAlerts, setShowAllAlerts] = useState(false)
  const visibleAlerts = showAllAlerts ? open : open.slice(0, 3)

  return (
    <>
      <PageHeader
        meta={<p className="eyebrow">Visão geral</p>}
        title="Situação financeira"
        description={
          <>
            Lançamentos registrados até <span className="num text-ink">{formatDateBR(o.today)}</span>. Projeções consideram apenas o que já está lançado.
          </>
        }
        actions={
          <ButtonLink to="/app/movimentacoes?novo=1" icon="plus" variant="secondary">
            Novo lançamento
          </ButtonLink>
        }
      />

      {/* A. SITUAÇÃO ATUAL — faixa de leitura única, não um conjunto de cards */}
      <section aria-labelledby="situacao" className="mb-6 overflow-hidden rounded-lg border border-line-soft">
        <h2 id="situacao" className="sr-only">
          Situação atual
        </h2>
        <div className="grid grid-cols-1 gap-px bg-line-soft sm:grid-cols-2 lg:grid-cols-6">
          <Figure
            to="/app/fluxo-de-caixa"
            label="Saldo registrado"
            definition={METRIC_DEFINITIONS.registeredBalance}
            featured
            value={<Money value={o.balance} tone="risk-only" className="text-[32px] leading-none font-semibold tracking-tight sm:text-[30px]" />}
            foot={o.balances.map((b) => (
              <span key={b.account.id} className="block truncate">
                {b.account.name} · <span className="num">{formatBRL(b.balance)}</span>
              </span>
            ))}
          />
          <Figure
            to="/app/movimentacoes?visao=receivables"
            label="A receber"
            definition={METRIC_DEFINITIONS.receivables}
            value={<Money value={o.receivables.total.value} className="text-xl font-semibold text-pos" />}
            foot={
              <>
                <span className="num">{o.receivables.dueNext7.count}</span> nos próximos 7 dias ·{' '}
                <span className="num">{formatBRL(o.receivables.dueNext7.value)}</span>
              </>
            }
          />
          <Figure
            to="/app/movimentacoes?visao=payables"
            label="A pagar"
            definition={METRIC_DEFINITIONS.payables}
            value={<Money value={o.payables.total.value} className="text-xl font-semibold text-risk" />}
            foot={
              <>
                <span className="num">{o.payables.dueNext7.count}</span> nos próximos 7 dias ·{' '}
                <span className="num">{formatBRL(o.payables.dueNext7.value)}</span>
              </>
            }
          />
          <Figure
            to="/app/movimentacoes?visao=overdue_receivables"
            label="Vencidos"
            definition={`${METRIC_DEFINITIONS.overdue} ${METRIC_DEFINITIONS.delinquency}`}
            value={
              <span className="flex flex-col gap-0.5 text-sm">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-ink-2">Receber</span>
                  <Money value={o.receivables.overdue.value} className={cx('font-semibold', o.receivables.overdue.count > 0 && 'text-warn')} />
                </span>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-ink-2">Pagar</span>
                  <Money value={o.payables.overdue.value} className={cx('font-semibold', o.payables.overdue.count > 0 && 'text-warn')} />
                </span>
              </span>
            }
            foot={
              o.delinquency.rate === null ? (
                'Sem vencimentos nos últimos 90 dias'
              ) : (
                <>
                  <span className="num">{o.delinquency.rate.toFixed(1).replace('.', ',')}%</span> dos recebimentos de 90 dias em atraso
                </>
              )
            }
          />
          <Figure
            to="/app/fluxo-de-caixa"
            label="Caixa projetado · 30 dias"
            definition={METRIC_DEFINITIONS.projectedCash}
            value={<Money value={o.projection30.endBalance} tone="risk-only" className="text-xl font-semibold" />}
            foot={
              <>
                Mínimo <Money value={o.projection30.minBalance} tone="risk-only" /> em{' '}
                <span className="num">{formatDateBR(o.projection30.minDate).slice(0, 5)}</span>
              </>
            }
          />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* B. O QUE MERECE ATENÇÃO */}
        <Panel
          className="lg:col-span-3"
          eyebrow="O que merece atenção"
          title={open.length ? `${open.length} ponto(s) em aberto, por prioridade` : 'Nada pendente'}
          actions={
            <Link to="/app/inteligencia" className="link text-xs">
              Central de inteligência
            </Link>
          }
          bodyClassName="p-0 sm:p-0"
        >
          {open.length === 0 ? (
            <EmptyState title="Nenhum alerta em aberto" icon="check">
              As regras de análise não encontraram pontos de atenção com os dados atuais.
            </EmptyState>
          ) : (
            <ol className="divide-y divide-line-soft">
              {visibleAlerts.map((a) => (
                <li key={a.fingerprint}>
                  <Link
                    to={`/app/inteligencia?alerta=${encodeURIComponent(a.fingerprint)}`}
                    className="group relative flex gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2/60 sm:gap-4 sm:px-5"
                  >
                    <span className={cx('absolute top-3.5 bottom-3.5 left-0 w-[3px] rounded-r', severityBar(a.severity))} aria-hidden="true" />
                    <Icon name={ALERT_ICON[a.severity]} size={16} className={cx('mt-0.5 shrink-0', ALERT_ICON_TONE[a.severity])} />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <SeverityTag severity={a.severity} />
                        {a.state === 'in_review' && <span className="text-2xs text-ink-3">em análise</span>}
                      </div>
                      <p className="text-sm font-medium text-ink">{a.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">{a.description}</p>
                    </div>
                    {a.impact !== null && (
                      <div className="hidden shrink-0 text-right sm:block">
                        <Money value={a.impact} className="text-sm font-medium text-ink" />
                        <p className="text-2xs text-ink-3">{a.impactLabel}</p>
                      </div>
                    )}
                    <Icon name="chevronRight" className="mt-1 shrink-0 text-ink-3 group-hover:text-ink" />
                  </Link>
                </li>
              ))}
              {open.length > 3 && (
                <li>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-center rounded-none"
                    aria-expanded={showAllAlerts}
                    onClick={() => setShowAllAlerts((v) => !v)}
                  >
                    {showAllAlerts ? 'Mostrar menos' : `Ver todos (${open.length})`}
                  </Button>
                </li>
              )}
            </ol>
          )}
        </Panel>

        {/* C. PRÓXIMA DECISÃO */}
        <NextDecision />
      </div>

      {/* D. EVOLUÇÃO */}
      <Panel className="mt-6" eyebrow="Evolução" title="Entradas e saídas realizadas · 6 meses" actions={<Legend />}>
        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
          <MonthlyBars data={o.evolution} />
          <dl className="grid content-start gap-3 text-sm">
            <p className="eyebrow">Mês atual · {formatMonthLabel(o.today.slice(0, 7))} até hoje</p>
            <Row label="Recebido" def={METRIC_DEFINITIONS.cashIn} to="/app/movimentacoes?visao=cash_in_month">
              <Money value={o.month.cashIn.value} className="text-pos" />
            </Row>
            <Row label="Pago" def={METRIC_DEFINITIONS.cashOut} to="/app/movimentacoes?visao=cash_out_month">
              <Money value={o.month.cashOut.value} className="text-risk" />
            </Row>
            <div className="border-t border-line-soft pt-3">
              <Row label="Resultado operacional estimado" def={METRIC_DEFINITIONS.operatingResult}>
                <Money value={o.month.operatingResult} tone="auto" className="font-semibold" />
              </Row>
              <p className="mt-1 text-2xs text-ink-3">Competência, simplificado. Não é lucro contábil.</p>
            </div>
          </dl>
        </div>
      </Panel>
    </>
  )
}

function Figure({
  label,
  definition,
  value,
  foot,
  to,
  featured,
}: {
  label: string
  definition: string
  value: ReactNode
  foot: ReactNode
  to: string
  featured?: boolean
}) {
  return (
    <div
      className={cx(
        'group relative flex min-w-0 flex-col justify-between gap-3 p-4 transition-colors sm:p-5',
        featured
          ? 'bg-gradient-to-br from-accent/10 via-surface to-surface ring-1 ring-inset ring-accent/25 hover:from-accent/20 sm:col-span-2'
          : 'bg-surface hover:bg-surface-2/60',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="eyebrow">{label}</span>
        <span className="relative z-10">
          <Definition text={definition} label={`Definição: ${label}`} />
        </span>
      </div>
      <div className="min-h-8">{value}</div>
      <div className="text-xs leading-relaxed text-ink-3">{foot}</div>
      <Link to={to} className="absolute inset-0" aria-label={`Ver lançamentos: ${label}`} />
    </div>
  )
}

function Row({ label, def, to, children }: { label: string; def: string; to?: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex items-center gap-1.5 text-ink-2">
        {to ? (
          <Link to={to} className="hover:text-ink hover:underline">
            {label}
          </Link>
        ) : (
          label
        )}
        <Definition text={def} label={`Definição: ${label}`} />
      </dt>
      <dd>{children}</dd>
    </div>
  )
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-2xs text-ink-3">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-sm bg-pos/75" /> Entradas
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-sm bg-accent/55" /> Saídas
      </span>
    </div>
  )
}

/** Pergunta de decisão com resposta imediata, calculada pelo mesmo motor da projeção. */
function NextDecision() {
  const data = useData()
  const o = useOverview()
  const [delay, setDelay] = useState(7)
  const delayed = useMemo(
    () =>
      projectCashflow({
        accounts: data.accounts,
        transactions: data.transactions,
        asOf: o.today,
        horizonDays: 30,
        assumptions: { ...BASE_SCENARIO, id: 'custom', receivableDelayDays: delay },
      }),
    [data, o.today, delay],
  )
  const base = o.projection30
  const delta = delayed.minBalance - base.minBalance
  return (
    <Panel className="lg:col-span-2" eyebrow="Próxima decisão" title="E se os recebimentos atrasarem?">
      <label htmlFor="delay" className="flex items-baseline justify-between text-sm text-ink-2">
        Atraso em todos os recebimentos previstos
        <span className="num text-base font-semibold text-ink">{delay} dias</span>
      </label>
      <input
        id="delay"
        type="range"
        min={0}
        max={30}
        step={1}
        value={delay}
        onChange={(e) => setDelay(Number(e.target.value))}
        className="mt-2 w-full accent-[#c9d5e8]"
      />
      <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line-soft bg-line-soft text-sm">
        <div className="bg-surface p-3">
          <dt className="text-2xs text-ink-3">Menor saldo · sem atraso</dt>
          <dd className="mt-1">
            <Money value={base.minBalance} tone="risk-only" className="font-semibold" />
            <span className="ml-1 text-2xs text-ink-3">{formatDateBR(base.minDate).slice(0, 5)}</span>
          </dd>
        </div>
        <div className="bg-surface p-3">
          <dt className="text-2xs text-ink-3">Menor saldo · com {delay} dias</dt>
          <dd className="mt-1">
            <Money value={delayed.minBalance} tone="risk-only" className="font-semibold" />
            <span className="ml-1 text-2xs text-ink-3">{formatDateBR(delayed.minDate).slice(0, 5)}</span>
          </dd>
        </div>
      </dl>
      <p className={cx('mt-3 text-sm', delayed.firstNegativeDate ? 'text-risk' : 'text-ink-2')}>
        {delayed.firstNegativeDate ? (
          <>
            O caixa ficaria negativo a partir de <strong className="num">{formatDateBR(delayed.firstNegativeDate)}</strong>.
          </>
        ) : delta === 0 ? (
          'Nesse cenário, o menor saldo dos próximos 30 dias não muda.'
        ) : (
          <>
            O menor saldo cai <Money value={-delta} /> e permanece positivo nos próximos 30 dias.
          </>
        )}
      </p>
      <div className="mt-3">
        <ProjectionChart
          height={120}
          points={delayed.days.map((d) => ({ date: d.date, balance: d.balance }))}
          compare={base.days.map((d) => ({ date: d.date, balance: d.balance }))}
          primaryLabel={`Com ${delay} dias`}
          compareLabel="Sem atraso"
          highlightDate={delayed.firstNegativeDate ?? delayed.minDate}
        />
      </div>
      <p className="mt-2 text-2xs text-ink-3">
        Horizonte de 30 dias até {formatDateBR(addDays(o.today, 29))}. Recebimentos vencidos não entram; pagamentos vencidos contam como pagos hoje.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <ButtonLink to="/app/simulador" size="sm" variant="secondary" icon="sliders">
          Testar outra decisão
        </ButtonLink>
        <ButtonLink to="/app/fluxo-de-caixa" size="sm" variant="ghost">
          Ver premissas e lançamentos
        </ButtonLink>
      </div>
    </Panel>
  )
}
