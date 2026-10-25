import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useData, useStore } from '@/data/store'
import { useProjection } from '@/data/useFinance'
import {
  BASE_SCENARIO,
  CONSERVATIVE_SCENARIO,
  compareProjections,
  describeAssumptions,
  type ScenarioAssumptions,
  type ScenarioId,
} from '@/domain/finance/projection'
import { METRIC_DEFINITIONS } from '@/domain/finance/metrics'
import { Button, Definition, Field, Input, Money, Notice, PageHeader, Panel, Segmented, cx } from '@/components/ui'
import { useToast } from '@/components/overlay'
import { ProjectionChart } from '@/components/charts'
import { formatDateBR, formatWeekday } from '@/lib/dates'
import { formatBRL, parseMoney } from '@/lib/money'

const HORIZONS = [7, 30, 90] as const

export default function CashflowPage() {
  const data = useData()
  const { actions } = useStore()
  const toast = useToast()
  const [horizon, setHorizon] = useState<number>(30)
  const [scenarioId, setScenarioId] = useState<ScenarioId>('base')
  const [custom, setCustom] = useState<ScenarioAssumptions>(data.customScenario)
  const [weekly, setWeekly] = useState(custom.estimatedWeeklyIncome ? (custom.estimatedWeeklyIncome / 100).toFixed(2).replace('.', ',') : '')
  const [eventsLimit, setEventsLimit] = useState(30)

  const assumptions = scenarioId === 'base' ? BASE_SCENARIO : scenarioId === 'conservative' ? CONSERVATIVE_SCENARIO : custom
  const base = useProjection(horizon, BASE_SCENARIO)
  const p = useProjection(horizon, assumptions)
  const cmp = useMemo(() => compareProjections(base, p), [base, p])
  const isBase = scenarioId === 'base'

  let running = p.startBalance
  const eventRows = p.events.map((e) => {
    running += e.direction === 'in' ? e.amount : -e.amount
    return { ...e, running }
  })

  return (
    <>
      <PageHeader
        meta={<p className="eyebrow">Fluxo de caixa projetado</p>}
        title="Para onde o caixa está indo"
        description="Saldo registrado de hoje somado ao que já está lançado para os próximos dias. Projeção é estimativa, não garantia."
        actions={
          <>
            <Segmented label="Horizonte" value={horizon} onChange={setHorizon} options={HORIZONS.map((h) => ({ value: h, label: `${h} dias` }))} />
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          label="Cenário"
          value={scenarioId}
          onChange={setScenarioId}
          options={[
            { value: 'base', label: 'Cenário-base' },
            { value: 'conservative', label: 'Conservador' },
            { value: 'custom', label: 'Personalizado' },
          ]}
        />
        {!isBase && <span className="text-xs text-ink-3">Linha tracejada = cenário-base</span>}
      </div>

      {scenarioId === 'custom' && (
        <Panel className="mb-4" eyebrow="Premissas do cenário personalizado" title="Ajuste e veja o efeito imediatamente">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Atraso dos recebimentos (dias)" htmlFor="c-delay">
              <Input
                id="c-delay"
                type="number"
                min={0}
                max={90}
                className="num"
                value={custom.receivableDelayDays}
                onChange={(e) => setCustom({ ...custom, receivableDelayDays: clamp(e.target.value, 0, 90) })}
              />
            </Field>
            <Field label="Desconsiderar dos recebimentos (%)" htmlFor="c-cut" hint="Margem de prudência, não probabilidade">
              <Input
                id="c-cut"
                type="number"
                min={0}
                max={100}
                className="num"
                value={custom.receivableHaircutPct}
                onChange={(e) => setCustom({ ...custom, receivableHaircutPct: clamp(e.target.value, 0, 100) })}
              />
            </Field>
            <Field label="Recebimentos vencidos" htmlFor="c-over">
              <select
                id="c-over"
                className="field"
                value={custom.includeOverdueReceivables ? String(custom.overdueAssumedInDays) : 'no'}
                onChange={(e) =>
                  setCustom({
                    ...custom,
                    includeOverdueReceivables: e.target.value !== 'no',
                    overdueAssumedInDays: e.target.value === 'no' ? 0 : Number(e.target.value),
                  })
                }
              >
                <option value="no">Não considerar</option>
                <option value="7">Receber em 7 dias</option>
                <option value="15">Receber em 15 dias</option>
                <option value="30">Receber em 30 dias</option>
              </select>
            </Field>
            <Field label="Receita semanal estimada (R$)" htmlFor="c-weekly" hint="Vendas ainda não lançadas; deixe vazio para ignorar">
              <Input
                id="c-weekly"
                inputMode="decimal"
                className="num"
                value={weekly}
                placeholder="0,00"
                onChange={(e) => {
                  setWeekly(e.target.value)
                  const v = parseMoney(e.target.value)
                  setCustom({ ...custom, estimatedWeeklyIncome: v && v > 0 ? v : 0 })
                }}
              />
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await actions.saveCustomScenario(custom)
                  toast('Premissas salvas para esta empresa')
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Não foi possível salvar.', 'risk')
                }
              }}
            >
              Salvar premissas
            </Button>
          </div>
        </Panel>
      )}

      {p.firstNegativeDate ? (
        <Notice tone="risk" title={`Saldo projetado negativo a partir de ${formatDateBR(p.firstNegativeDate)}`} className="mb-4">
          {p.negativeDays} dia(s) abaixo de zero no horizonte. Menor saldo de <span className="num">{formatBRL(p.minBalance)}</span> em{' '}
          {formatDateBR(p.minDate)}.{' '}
          <Link to="/app/simulador" className="link">
            Testar alternativas no simulador
          </Link>
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <Panel
          eyebrow={`${isBase ? 'Cenário-base' : scenarioId === 'conservative' ? 'Cenário conservador' : 'Cenário personalizado'} · ${horizon} dias`}
          title={`${formatDateBR(p.asOf)} a ${formatDateBR(p.endDate)}`}
        >
          <ProjectionChart
            points={p.days.map((d) => ({ date: d.date, balance: d.balance, inflow: d.inflow, outflow: d.outflow }))}
            compare={isBase ? undefined : base.days.map((d) => ({ date: d.date, balance: d.balance }))}
            compareLabel="Cenário-base"
            highlightDate={p.firstNegativeDate ?? p.minDate}
            safetyLine={data.alertConfig.safetyMargin}
            height={260}
          />
          <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line-soft bg-line-soft text-sm sm:grid-cols-5">
            <Stat label="Saldo inicial" def={METRIC_DEFINITIONS.registeredBalance} value={<Money value={p.startBalance} tone="risk-only" />} />
            <Stat label="Entradas" value={<Money value={p.totalIn} className="text-pos" />} />
            <Stat label="Saídas" value={<Money value={p.totalOut} />} />
            <Stat label="Saldo final" value={<Money value={p.endBalance} tone="risk-only" className="font-semibold" />} />
            <Stat label={`Mínimo · ${formatDateBR(p.minDate).slice(0, 5)}`} value={<Money value={p.minBalance} tone="risk-only" className="font-semibold" />} />
          </dl>
          {!isBase && (
            <p className="mt-3 text-xs text-ink-2">
              Em relação ao cenário-base: saldo mínimo <Money value={cmp.minBalanceDelta} signed tone="auto" />, saldo final{' '}
              <Money value={cmp.endBalanceDelta} signed tone="auto" />
              {cmp.newNegativeDate && (
                <>
                  , e passa a ficar negativo em <span className="num text-risk">{formatDateBR(cmp.newNegativeDate)}</span>
                </>
              )}
              .
            </p>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel eyebrow="Premissas" title="O que este cálculo assume">
            <ul className="space-y-2 text-sm text-ink-2">
              <li className="flex gap-2">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-3" />
                Saldo inicial: saldo registrado em {formatDateBR(p.asOf)}.
              </li>
              {describeAssumptions(assumptions).map((l) => (
                <li key={l} className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-3" />
                  {l}
                </li>
              ))}
            </ul>
            <div className="mt-4 space-y-1 border-t border-line-soft pt-3 text-xs text-ink-3">
              {p.excluded.overdueReceivables.count > 0 && (
                <p>
                  Fora do cálculo: <span className="num text-ink-2">{formatBRL(p.excluded.overdueReceivables.amount)}</span> em{' '}
                  {p.excluded.overdueReceivables.count} recebimento(s) vencido(s).{' '}
                  <Link className="link" to="/app/movimentacoes?visao=overdue_receivables">
                    Ver
                  </Link>
                </p>
              )}
              {p.excluded.haircut > 0 && (
                <p>
                  Desconsiderado por prudência: <span className="num text-ink-2">{formatBRL(p.excluded.haircut)}</span>.
                </p>
              )}
              {p.excluded.beyondHorizon.count > 0 && (
                <p>
                  {p.excluded.beyondHorizon.count} lançamento(s) pendente(s) vencem depois de {formatDateBR(p.endDate)}.
                </p>
              )}
            </div>
          </Panel>

          {p.lastInflowDate && p.lastInflowDate < p.endDate && assumptions.estimatedWeeklyIncome === 0 && (
            <Notice tone="warn" title="Cobertura de recebimentos">
              O último recebimento registrado no horizonte é de {formatDateBR(p.lastInflowDate)}. Depois disso, a projeção só tem saídas e tende a subestimar o
              caixa. Use o cenário personalizado para informar uma receita semanal estimada.
            </Notice>
          )}

          <Panel eyebrow="Dias de maior pressão" title="Maior saída líquida no horizonte">
            {p.pressureDays.length === 0 ? (
              <p className="text-sm text-ink-3">Nenhum dia com saída líquida no período.</p>
            ) : (
              <ol className="space-y-3">
                {p.pressureDays.map((d) => (
                  <li key={d.date} className="text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="num text-ink">
                        {formatDateBR(d.date)} <span className="text-ink-3">{formatWeekday(d.date)}</span>
                      </span>
                      <Money value={d.inflow - d.outflow} signed className="font-medium" />
                    </div>
                    <p className="truncate text-xs text-ink-3">
                      {d.events
                        .filter((e) => e.direction === 'out')
                        .slice(0, 3)
                        .map((e) => e.description)
                        .join(' · ')}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>

      <Panel className="mt-6" eyebrow="Rastreabilidade" title="Lançamentos considerados, em ordem" bodyClassName="p-0 sm:p-0">
        {eventRows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-3">Nenhum lançamento pendente no horizonte. O saldo permanece igual ao registrado.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line-soft text-left text-2xs tracking-wider text-ink-3 uppercase">
                  <th className="px-5 py-2.5 font-medium">Data considerada</th>
                  <th className="px-3 py-2.5 font-medium">Lançamento</th>
                  <th className="px-3 py-2.5 text-right font-medium">Valor</th>
                  <th className="px-5 py-2.5 text-right font-medium">Saldo após</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {eventRows.slice(0, eventsLimit).map((e, i) => (
                  <tr key={`${e.txId ?? 'v'}-${i}`}>
                    <td className="num px-5 py-2 whitespace-nowrap text-ink-2">
                      {formatDateBR(e.effectiveDate)}
                      {e.effectiveDate !== e.originalDate && <span className="block text-2xs text-ink-3">original {formatDateBR(e.originalDate)}</span>}
                    </td>
                    <td className="max-w-0 px-3 py-2">
                      <p className="truncate text-ink">{e.description}</p>
                      {(e.adjustment || e.virtual) && (
                        <p className="truncate text-xs text-warn/80">{e.virtual ? 'premissa, não é lançamento' : e.adjustment}</p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money value={e.direction === 'in' ? e.amount : -e.amount} signed className={e.direction === 'in' ? 'text-pos' : 'text-ink'} />
                    </td>
                    <td className={cx('px-5 py-2 text-right', e.running < 0 && 'text-risk')}>
                      <Money value={e.running} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {eventRows.length > eventsLimit && (
              <div className="border-t border-line-soft px-5 py-2.5">
                <Button size="sm" variant="ghost" onClick={() => setEventsLimit((l) => l + 50)}>
                  Mostrar mais ({eventRows.length - eventsLimit} restantes)
                </Button>
              </div>
            )}
          </div>
        )}
      </Panel>
      <p className="mt-4 text-xs text-ink-3">
        Projeções são estimativas baseadas nos lançamentos registrados e nas premissas exibidas. Não constituem garantia de resultado nem recomendação
        financeira.
      </p>
    </>
  )
}

function Stat({ label, value, def }: { label: string; value: React.ReactNode; def?: string }) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <dt className="flex items-center gap-1 text-2xs text-ink-3">
        {label}
        {def && <Definition text={def} />}
      </dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  )
}

function clamp(v: string, min: number, max: number) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}
