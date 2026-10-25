import { useMemo, useState } from 'react'
import { useData, useStore } from '@/data/store'
import { DECISION_LABELS, DecisionError, simulate, type Decision, type DecisionType } from '@/domain/finance/simulation'
import { Button, EmptyState, Field, Input, Money, Notice, PageHeader, Panel, Segmented, Select, cx } from '@/components/ui'
import { useToast } from '@/components/overlay'
import { ProjectionChart } from '@/components/charts'
import { addDays, formatDateBR, isISODate } from '@/lib/dates'
import { formatBRL, parseMoney } from '@/lib/money'

const uid = () => Math.random().toString(36).slice(2, 10)

export default function SimulatorPage() {
  const data = useData()
  const { today, actions } = useStore()
  const toast = useToast()
  const [horizon, setHorizon] = useState(90)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [name, setName] = useState('')

  const result = useMemo(() => {
    try {
      return { ok: true as const, r: simulate({ accounts: data.accounts, transactions: data.transactions, asOf: today, horizonDays: horizon, decisions }) }
    } catch (e) {
      return { ok: false as const, message: e instanceof DecisionError ? e.message : 'Não foi possível calcular a simulação.' }
    }
  }, [data.accounts, data.transactions, today, horizon, decisions])

  return (
    <>
      <PageHeader
        meta={<p className="eyebrow">Simulador de decisões</p>}
        title="Teste antes de decidir"
        description="Combine decisões e compare com o cenário atual. Usa o mesmo motor da projeção de caixa. Nenhum lançamento real é alterado."
        actions={<Segmented label="Horizonte" value={horizon} onChange={setHorizon} options={[30, 90, 180].map((h) => ({ value: h, label: `${h} dias` }))} />}
      />

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <div className="space-y-6">
          <DecisionBuilder onAdd={(d) => setDecisions((x) => [...x, d])} />
          <Panel eyebrow="Decisões no cenário" title={decisions.length ? `${decisions.length} decisão(ões)` : 'Nenhuma ainda'}>
            {decisions.length === 0 ? (
              <p className="text-sm text-ink-3">Adicione uma decisão para ver o impacto. Você pode combinar várias.</p>
            ) : (
              <ul className="divide-y divide-line-soft text-sm">
                {decisions.map((d) => (
                  <li key={d.id} className="flex items-start justify-between gap-3 py-2 first:pt-0">
                    <div className="min-w-0">
                      <p className="text-xs text-ink-3">{DECISION_LABELS[d.type]}</p>
                      <p className="truncate text-ink">{d.label}</p>
                    </div>
                    <button
                      className="shrink-0 rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-risk"
                      aria-label={`Remover ${d.label}`}
                      onClick={() => setDecisions((x) => x.filter((y) => y.id !== d.id))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          {!result.ok ? (
            <Notice tone="risk" title="Decisão inválida">
              {result.message}
            </Notice>
          ) : (
            <>
              <Panel eyebrow="Resultado" title="Cenário atual × alternativo" actions={<ChartLegend />}>
                <ProjectionChart
                  points={result.r.alternative.days.map((d) => ({ date: d.date, balance: d.balance, inflow: d.inflow, outflow: d.outflow }))}
                  compare={result.r.current.days.map((d) => ({ date: d.date, balance: d.balance }))}
                  primaryLabel="Alternativo"
                  compareLabel="Atual"
                  highlightDate={result.r.alternative.firstNegativeDate ?? result.r.alternative.minDate}
                  height={260}
                />
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead>
                      <tr className="border-b border-line-soft text-left text-2xs tracking-wider text-ink-3 uppercase">
                        <th className="py-2 font-medium" />
                        <th className="py-2 text-right font-medium">Atual</th>
                        <th className="py-2 text-right font-medium">Alternativo</th>
                        <th className="py-2 text-right font-medium">Diferença</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      <CmpRow label="Saldo mínimo" a={result.r.current.minBalance} b={result.r.alternative.minBalance} />
                      <CmpRow label="Saldo final" a={result.r.current.endBalance} b={result.r.alternative.endBalance} />
                      <CmpRow label="Entradas" a={result.r.current.totalIn} b={result.r.alternative.totalIn} />
                      <CmpRow label="Saídas" a={result.r.current.totalOut} b={result.r.alternative.totalOut} invert />
                      <tr>
                        <td className="py-2 text-ink-2">Primeiro dia negativo</td>
                        <td className="num py-2 text-right">
                          {formatDateBR(result.r.current.firstNegativeDate) === '—' ? 'nenhum' : formatDateBR(result.r.current.firstNegativeDate)}
                        </td>
                        <td className={cx('num py-2 text-right', result.r.alternative.firstNegativeDate && 'text-risk')}>
                          {result.r.alternative.firstNegativeDate ? formatDateBR(result.r.alternative.firstNegativeDate) : 'nenhum'}
                        </td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Panel>

              {result.r.current.lastInflowDate && result.r.current.lastInflowDate < result.r.current.endDate && (
                <Notice tone="warn" title="Cobertura de recebimentos">
                  Não há recebimentos registrados depois de {formatDateBR(result.r.current.lastInflowDate)}. Os dois cenários tendem a subestimar o caixa a
                  partir daí — compare a diferença entre eles, não o saldo absoluto. Para incluir vendas futuras, use a decisão "Aumento de vendas" ou o cenário
                  personalizado do fluxo de caixa.
                </Notice>
              )}
              {result.r.criticalDates.length > 0 && (
                <Notice tone="risk" title={`${result.r.criticalDates.length} dia(s) com saldo negativo no cenário alternativo`}>
                  De {formatDateBR(result.r.criticalDates[0])} a {formatDateBR(result.r.criticalDates[result.r.criticalDates.length - 1])} (não necessariamente
                  contínuos).
                </Notice>
              )}

              <Panel eyebrow="Premissas utilizadas" title="Como a simulação foi montada">
                <ul className="space-y-1.5 text-sm text-ink-2">
                  <li>· Cenário-base da projeção: recebimentos no vencimento; vencidos fora; pagamentos vencidos considerados hoje.</li>
                  {result.r.assumptions.map((a) => (
                    <li key={a}>· {a}</li>
                  ))}
                  <li>· Impostos, juros e encargos decorrentes das decisões não são calculados automaticamente.</li>
                </ul>
                {decisions.length > 0 && (
                  <form
                    className="mt-4 flex flex-wrap items-end gap-2 border-t border-line-soft pt-4"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      const n = name.trim() || `Cenário de ${formatDateBR(today)}`
                      try {
                        await actions.saveScenario({
                          name: n.slice(0, 80),
                          horizonDays: horizon,
                          decisions,
                          asOf: today,
                          resultSummary: {
                            currentMin: result.r.current.minBalance,
                            alternativeMin: result.r.alternative.minBalance,
                            endDelta: result.r.comparison.endBalanceDelta,
                            firstNegative: result.r.alternative.firstNegativeDate,
                          },
                        })
                        setName('')
                        toast('Cenário salvo. Os lançamentos reais não foram alterados.')
                      } catch (err) {
                        toast(err instanceof Error ? err.message : 'Não foi possível salvar o cenário.', 'risk')
                      }
                    }}
                  >
                    <div className="min-w-48 flex-1">
                      <Field label="Nome do cenário" htmlFor="sc-name">
                        <Input
                          id="sc-name"
                          value={name}
                          maxLength={80}
                          placeholder="Ex.: Contratar auxiliar em dezembro"
                          onChange={(e) => setName(e.target.value)}
                        />
                      </Field>
                    </div>
                    <Button type="submit">Salvar cenário</Button>
                  </form>
                )}
              </Panel>
            </>
          )}

          <Panel eyebrow="Cenários salvos" title="Para comparar e reabrir">
            {data.scenarios.length === 0 ? (
              <EmptyState title="Nenhum cenário salvo">Salvar um cenário guarda as decisões e o resultado da data em que foi calculado.</EmptyState>
            ) : (
              <ul className="divide-y divide-line-soft text-sm">
                {data.scenarios.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ink">{s.name}</p>
                      <p className="text-xs text-ink-3">
                        {s.decisions.length} decisão(ões) · {s.horizonDays} dias · calculado em {formatDateBR(s.asOf)} · mínimo{' '}
                        <span className={cx('num', s.resultSummary.alternativeMin < 0 && 'text-risk')}>{formatBRL(s.resultSummary.alternativeMin)}</span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDecisions(s.decisions)
                        setHorizon(s.horizonDays)
                        window.scrollTo({ top: 0, behavior: 'smooth' })
                      }}
                    >
                      Reabrir
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="hover:text-risk"
                      onClick={() =>
                        actions.deleteScenario(s.id).catch((err) => toast(err instanceof Error ? err.message : 'Não foi possível excluir.', 'risk'))
                      }
                      aria-label={`Excluir cenário ${s.name}`}
                    >
                      Excluir
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}

function ChartLegend() {
  return (
    <div className="flex items-center gap-3 text-2xs text-ink-3">
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-4 bg-[#c9d5e8]" /> Alternativo
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-0 w-4 border-t border-dashed border-ink-3" /> Atual
      </span>
    </div>
  )
}

function CmpRow({ label, a, b, invert }: { label: string; a: number; b: number; invert?: boolean }) {
  const d = b - a
  return (
    <tr>
      <td className="py-2 text-ink-2">{label}</td>
      <td className="py-2 text-right">
        <Money value={a} tone="risk-only" />
      </td>
      <td className="py-2 text-right">
        <Money value={b} tone="risk-only" />
      </td>
      <td className="py-2 text-right">
        <Money value={d} signed className={d === 0 ? 'text-ink-3' : (invert ? d < 0 : d > 0) ? 'text-pos' : 'text-risk'} />
      </td>
    </tr>
  )
}

const TYPES: DecisionType[] = ['hire', 'equipment', 'renegotiate', 'fixed_increase', 'cost_reduction', 'shift_receivable', 'sales_increase']

function DecisionBuilder({ onAdd }: { onAdd: (d: Decision) => void }) {
  const data = useData()
  const { today } = useStore()
  const [type, setType] = useState<DecisionType>('hire')
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(addDays(today, 7))
  const [installments, setInstallments] = useState('1')
  const [txId, setTxId] = useState('')
  const [days, setDays] = useState('7')
  const [error, setError] = useState<string | null>(null)

  const payables = data.transactions.filter((t) => t.kind === 'expense' && t.status === 'pending').sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const receivables = data.transactions
    .filter((t) => t.kind === 'income' && t.status === 'pending' && t.dueDate >= today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const needsAmount = !['renegotiate', 'shift_receivable'].includes(type)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const value = parseMoney(amount)
    if (needsAmount && (value === null || value <= 0)) return setError('Informe um valor maior que zero.')
    if ((needsAmount || type === 'renegotiate') && !isISODate(date)) return setError('Informe uma data válida.')
    const id = uid()
    const l = label.trim() || DECISION_LABELS[type]
    let d: Decision
    switch (type) {
      case 'hire':
        d = { id, type, label: l, monthlyCost: value!, startDate: date }
        break
      case 'equipment': {
        const n = Number(installments)
        if (!Number.isInteger(n) || n < 1 || n > 48) return setError('Parcelas entre 1 e 48.')
        d = { id, type, label: l, amount: value!, firstDate: date, installments: n }
        break
      }
      case 'fixed_increase':
      case 'cost_reduction':
      case 'sales_increase':
        d = { id, type, label: l, monthlyAmount: value!, startDate: date }
        break
      case 'renegotiate': {
        const tx = payables.find((t) => t.id === txId)
        if (!tx) return setError('Selecione a conta a pagar.')
        d = { id, type, label: label.trim() || `Renegociar ${tx.description}`, txId, newDate: date }
        break
      }
      case 'shift_receivable': {
        const tx = receivables.find((t) => t.id === txId)
        const n = Number(days)
        if (!tx) return setError('Selecione o recebimento.')
        if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 180) return setError('Informe dias entre −180 e 180 (diferente de zero).')
        d = { id, type, label: label.trim() || `${n > 0 ? 'Atrasar' : 'Antecipar'} ${tx.description}`, txId, days: n }
        break
      }
    }
    onAdd(d)
    setLabel('')
    setAmount('')
    setTxId('')
  }

  const amountLabel =
    type === 'hire'
      ? 'Custo mensal total (salário + encargos)'
      : type === 'equipment'
        ? 'Valor total'
        : type === 'cost_reduction'
          ? 'Economia mensal'
          : type === 'sales_increase'
            ? 'Receita adicional mensal'
            : 'Aumento mensal'

  return (
    <Panel eyebrow="Nova decisão" title="O que você está considerando?">
      <form onSubmit={submit} className="space-y-3" noValidate>
        <Field label="Tipo de decisão" htmlFor="d-type">
          <Select
            id="d-type"
            value={type}
            onChange={(e) => {
              setType(e.target.value as DecisionType)
              setTxId('')
              setError(null)
            }}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {DECISION_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        {type === 'renegotiate' && (
          <Field label="Conta a pagar" htmlFor="d-tx">
            <Select id="d-tx" value={txId} onChange={(e) => setTxId(e.target.value)}>
              <option value="">Selecione</option>
              {payables.map((t) => (
                <option key={t.id} value={t.id}>
                  {formatDateBR(t.dueDate)} · {t.description} · {formatBRL(t.amount)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {type === 'shift_receivable' && (
          <>
            <Field label="Recebimento previsto" htmlFor="d-tx">
              <Select id="d-tx" value={txId} onChange={(e) => setTxId(e.target.value)}>
                <option value="">Selecione</option>
                {receivables.map((t) => (
                  <option key={t.id} value={t.id}>
                    {formatDateBR(t.dueDate)} · {t.counterparty ?? t.description} · {formatBRL(t.amount)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Dias (positivo atrasa, negativo antecipa)" htmlFor="d-days">
              <Input id="d-days" type="number" className="num" value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
          </>
        )}
        {needsAmount && (
          <Field label={`${amountLabel} (R$)`} htmlFor="d-amount">
            <Input id="d-amount" inputMode="decimal" className="num" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}
        {type === 'equipment' && (
          <Field label="Parcelas mensais" htmlFor="d-inst">
            <Input id="d-inst" type="number" min={1} max={48} className="num" value={installments} onChange={(e) => setInstallments(e.target.value)} />
          </Field>
        )}
        {type !== 'shift_receivable' && (
          <Field label={type === 'renegotiate' ? 'Novo vencimento' : type === 'equipment' ? 'Primeira parcela' : 'A partir de'} htmlFor="d-date">
            <Input id="d-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
        <Field label="Descrição (opcional)" htmlFor="d-label">
          <Input id="d-label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="text-xs text-risk">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" icon="plus" className="w-full">
          Adicionar ao cenário
        </Button>
      </form>
    </Panel>
  )
}
