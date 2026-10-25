import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { AlertState } from '@/domain/types'
import { useStore } from '@/data/store'
import { useAlerts, useOverview, type AlertWithState } from '@/data/useFinance'
import { buildLocalCashAnalysis, reviewAnalysis, type AgentKind } from '@/domain/ai/analysis'
import type { AiAnalysisResponse } from '@/data/repository'
import { Button, ButtonLink, EmptyState, Money, Notice, PageHeader, Panel, Segmented, SeverityTag, Tag, cx, severityBar } from '@/components/ui'
import { useToast } from '@/components/overlay'
import { Icon } from '@/components/icons'
import { formatDateBR } from '@/lib/dates'

type Filter = 'open' | 'resolved' | 'ignored' | 'all'
const STATE_LABEL: Record<AlertState, string> = { new: 'Novo', in_review: 'Em análise', resolved: 'Resolvido', ignored: 'Ignorado' }

export default function IntelligencePage() {
  const { alerts, skipped } = useAlerts()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<Filter>('open')
  const selectedFp = params.get('alerta')

  const list = alerts.filter((a) => (filter === 'all' ? true : filter === 'open' ? a.state === 'new' || a.state === 'in_review' : a.state === filter))
  const selected = alerts.find((a) => a.fingerprint === selectedFp) ?? list[0] ?? null
  const counts = {
    open: alerts.filter((a) => a.state === 'new' || a.state === 'in_review').length,
    resolved: alerts.filter((a) => a.state === 'resolved').length,
    ignored: alerts.filter((a) => a.state === 'ignored').length,
  }

  return (
    <>
      <PageHeader
        meta={<p className="eyebrow">Inteligência financeira</p>}
        title="Central de decisões"
        description="Regras determinísticas sobre os seus lançamentos. Cada alerta mostra evidências, período, origem e os lançamentos que o sustentam."
      />

      <div className="mb-4">
        <Segmented
          label="Filtrar alertas"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: `Em aberto · ${counts.open}` },
            { value: 'resolved', label: `Resolvidos · ${counts.resolved}` },
            { value: 'ignored', label: `Ignorados · ${counts.ignored}` },
            { value: 'all', label: 'Todos' },
          ]}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="overflow-hidden rounded-lg border border-line-soft bg-surface">
          {list.length === 0 ? (
            <EmptyState title={filter === 'open' ? 'Nenhum alerta em aberto' : 'Nada nesta lista'} icon="check">
              {filter === 'open' ? 'As regras não encontraram pontos de atenção com os dados atuais.' : 'Alertas marcados aparecem aqui.'}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line-soft" role="listbox" aria-label="Alertas">
              {list.map((a) => {
                const active = selected?.fingerprint === a.fingerprint
                return (
                  <li key={a.fingerprint} role="option" aria-selected={active}>
                    <button
                      onClick={() => setParams({ alerta: a.fingerprint }, { replace: true })}
                      className={cx('relative block w-full px-4 py-3 text-left transition-colors', active ? 'bg-surface-2' : 'hover:bg-surface-2/50')}
                    >
                      <span className={cx('absolute top-3 bottom-3 left-0 w-[3px] rounded-r', severityBar(a.severity))} aria-hidden="true" />
                      <span className="mb-1 flex items-center gap-2">
                        <SeverityTag severity={a.severity} />
                        <span className="text-2xs text-ink-3">{STATE_LABEL[a.state]}</span>
                      </span>
                      <span className="block text-sm font-medium text-ink">{a.title}</span>
                      {a.impact !== null && (
                        <span className="mt-0.5 block text-xs text-ink-3">
                          <Money value={a.impact} className="text-ink-2" /> {a.impactLabel}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="space-y-6">
          {selected ? <AlertDetail alert={selected} /> : null}

          {skipped.length > 0 && (
            <Panel eyebrow="Análises não realizadas" title="Dados insuficientes para comparação">
              <ul className="space-y-2 text-sm">
                {skipped.map((s) => (
                  <li key={s.rule}>
                    <span className="font-medium text-ink">{s.rule}:</span> <span className="text-ink-2">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <AnalysisPanel />
        </div>
      </div>
    </>
  )
}

function AlertDetail({ alert: a }: { alert: AlertWithState }) {
  const { actions } = useStore()
  const toast = useToast()
  const [busy, setBusy] = useState<AlertState | null>(null)
  const setState = async (s: AlertState) => {
    setBusy(s)
    try {
      await actions.setAlertState(a.fingerprint, s)
      toast(`Alerta marcado como "${STATE_LABEL[s].toLowerCase()}"`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não foi possível atualizar o alerta.', 'risk')
    } finally {
      setBusy(null)
    }
  }
  return (
    <Panel eyebrow="Detalhe do alerta" title={a.title} actions={<SeverityTag severity={a.severity} />}>
      <p className="text-sm leading-relaxed text-ink-2">{a.description}</p>

      <h3 className="eyebrow mt-5 mb-2">Evidências</h3>
      <dl className="divide-y divide-line-soft rounded-md border border-line-soft">
        {a.evidence.map((e, i) => (
          <div key={i} className="flex items-baseline justify-between gap-4 px-3 py-2 text-sm">
            <dt className="min-w-0 text-ink-2">{e.label}</dt>
            <dd className="num shrink-0 text-ink">{e.value}</dd>
          </div>
        ))}
      </dl>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Meta label="Período analisado" value={`${formatDateBR(a.period.start)} – ${formatDateBR(a.period.end)}`} />
        <Meta label="Detectado em" value={formatDateBR(a.detectedOn)} />
        <Meta label="Origem dos dados" value={a.source} />
        <Meta
          label="Impacto estimado"
          value={
            a.impact === null ? (
              a.impactLabel
            ) : (
              <>
                <Money value={a.impact} /> <span className="text-ink-3">{a.impactLabel}</span>
              </>
            )
          }
        />
      </dl>

      <div className="mt-5 rounded-md border border-line-soft bg-surface-2/60 px-3.5 py-3">
        <p className="eyebrow mb-1">Próxima ação sugerida</p>
        <p className="text-sm text-ink">{a.nextAction}</p>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <ButtonLink to={`/app/movimentacoes?alerta=${encodeURIComponent(a.fingerprint)}`} variant="secondary" size="sm" icon="list">
          Ver {a.transactionIds.length} lançamento(s)
        </ButtonLink>
        {(a.rule === 'payment_concentration' || a.rule === 'negative_cash_risk') && (
          <ButtonLink to="/app/simulador" variant="ghost" size="sm" icon="sliders">
            Simular alternativa
          </ButtonLink>
        )}
        <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
        <span className="text-xs text-ink-3">
          Estado: <Tag>{STATE_LABEL[a.state]}</Tag>
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {a.state !== 'in_review' && a.state !== 'resolved' && (
            <Button size="sm" variant="ghost" loading={busy === 'in_review'} onClick={() => setState('in_review')}>
              Em análise
            </Button>
          )}
          {a.state !== 'resolved' && (
            <Button size="sm" variant="ghost" icon="check" loading={busy === 'resolved'} onClick={() => setState('resolved')}>
              Resolvido
            </Button>
          )}
          {a.state !== 'ignored' && a.state !== 'resolved' && (
            <Button size="sm" variant="ghost" loading={busy === 'ignored'} onClick={() => setState('ignored')}>
              Ignorar
            </Button>
          )}
          {(a.state === 'resolved' || a.state === 'ignored') && (
            <Button size="sm" variant="ghost" loading={busy === 'new'} onClick={() => setState('new')}>
              Reabrir
            </Button>
          )}
        </div>
      </div>
      {a.limitation && <p className="mt-3 text-xs text-ink-3">{a.limitation}</p>}
    </Panel>
  )
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-ink-2">{value}</dd>
    </div>
  )
}

/** Área das análises sob demanda. No modo demo só existe o exemplo local identificado. */
function AnalysisPanel() {
  const { repo } = useStore()
  return repo.mode === 'demo' ? <LocalAnalysisExample /> : <ServerAnalysisPanel />
}

function LocalAnalysisExample() {
  const o = useOverview()
  const { alerts } = useAlerts()
  const [show, setShow] = useState(false)
  const result = useMemo(() => {
    if (!show) return null
    const { analysis, facts } = buildLocalCashAnalysis(o.projection30, alerts)
    return { analysis, facts, review: reviewAnalysis(analysis, facts) }
  }, [show, o.projection30, alerts])

  return (
    <Panel eyebrow="Análises sob demanda" title="Agente de caixa">
      <Notice tone="accent" title="Análises por IA indisponíveis">
        Nenhum provedor de IA está configurado neste ambiente. Todos os indicadores, projeções e alertas acima são calculados por regras determinísticas e não
        dependem de IA.
      </Notice>
      {!show ? (
        <Button className="mt-4" size="sm" icon="eye" onClick={() => setShow(true)}>
          Ver exemplo demonstrativo
        </Button>
      ) : (
        result && (
          <div className="mt-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Tag tone="warn">Exemplo demonstrativo</Tag>
              <span className="text-xs text-ink-3">Montado por regras locais a partir dos números calculados. Nenhuma IA foi chamada.</span>
            </div>
            <p className="text-sm leading-relaxed text-ink">{result.analysis.summary}</p>
            <Section title="Evidências">
              {result.analysis.evidence.map((e) => (
                <li key={e.factKey}>{e.claim}</li>
              ))}
            </Section>
            <Section title="Premissas">
              {result.analysis.assumptions.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </Section>
            <Section title="Limitações">
              {result.analysis.limitations.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </Section>
            <Section title="Ações sugeridas">
              {result.analysis.suggestedActions.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </Section>
            <ReviewBox review={result.review} />
            <PeriodLine period={result.analysis.period} />
          </div>
        )
      )}
    </Panel>
  )
}

const AGENT_OPTIONS: { value: AgentKind; label: string }[] = [
  { value: 'cash', label: 'Caixa' },
  { value: 'expenses', label: 'Despesas' },
  { value: 'scenarios', label: 'Cenários' },
]

function ServerAnalysisPanel() {
  const { repo } = useStore()
  const [agent, setAgent] = useState<AgentKind>('cash')
  const [result, setResult] = useState<AiAnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      setResult(await repo.requestAnalysis(agent))
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Não foi possível gerar a análise.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Panel eyebrow="Análises sob demanda" title="Agente de análise">
      <Notice tone="accent" title="Gerado no servidor, revisado automaticamente">
        A análise usa apenas dados agregados da empresa, roda no servidor com o seu acesso e passa por um revisor antes de ser exibida. É uma estimativa, não
        uma garantia de resultado.
      </Notice>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <p className="eyebrow mb-1">Agente</p>
          <Segmented
            label="Agente de análise"
            size="sm"
            value={agent}
            options={AGENT_OPTIONS}
            onChange={(value) => {
              setAgent(value)
              setResult(null)
              setError(null)
            }}
          />
        </div>
        <Button size="sm" loading={loading} onClick={generate}>
          Gerar análise
        </Button>
      </div>
      {error && (
        <Notice tone="risk" className="mt-4">
          {error}
        </Notice>
      )}
      {result && <AnalysisResultView result={result} />}
    </Panel>
  )
}

function AnalysisResultView({ result }: { result: AiAnalysisResponse }) {
  const { analysis, review, cached } = result
  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {review.valid ? <Tag tone="accent">Gerado por IA, revisado automaticamente</Tag> : <Tag tone="risk">Gerada por IA — reprovada pelo revisor</Tag>}
        {cached && <Tag>Do cache</Tag>}
      </div>
      <p className="text-sm leading-relaxed text-ink">{analysis.summary}</p>
      <Section title="Evidências">
        {analysis.evidence.map((e) => (
          <li key={`${e.factKey}:${e.claim}`}>{e.claim}</li>
        ))}
      </Section>
      <Section title="Premissas">
        {analysis.assumptions.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </Section>
      <Section title="Limitações">
        {analysis.limitations.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </Section>
      <Section title="Ações sugeridas">
        {analysis.suggestedActions.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </Section>
      <ReviewBox review={review} />
      <PeriodLine period={analysis.period} />
    </div>
  )
}

function ReviewBox({ review }: { review: AiAnalysisResponse['review'] }) {
  return (
    <div
      className={cx('mt-4 flex items-start gap-2 rounded-md border px-3 py-2 text-xs', review.valid ? 'border-pos/25 text-pos' : 'border-risk/30 text-risk')}
    >
      <Icon name={review.valid ? 'check' : 'alert'} size={14} className="mt-px shrink-0" />
      <span>
        Revisor de análises:{' '}
        {review.valid
          ? 'todas as afirmações têm evidência e os valores conferem com os cálculos.'
          : `análise reprovada — ${review.issues.join('; ')}. Não use como referência.`}
      </span>
    </div>
  )
}

function PeriodLine({ period }: { period: AiAnalysisResponse['analysis']['period'] }) {
  return (
    <p className="mt-2 text-2xs text-ink-3">
      Período: {period.start && period.end ? `${formatDateBR(period.start)} – ${formatDateBR(period.end)}` : 'não informado'}
    </p>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="eyebrow mb-1">{title}</p>
      <ul className="list-disc space-y-0.5 pl-4 text-sm text-ink-2 marker:text-ink-3">{children}</ul>
    </div>
  )
}
