import { useMemo, useState } from 'react'
import { useData, useStore } from '@/data/store'
import { useAlerts } from '@/data/useFinance'
import { REPORT_LABELS, buildReport, formatCell, reportToTable, type ReportKind } from '@/domain/reports'
import { toCSV } from '@/domain/import/csv'
import { Button, EmptyState, Field, Input, PageHeader, Select, Tag, cx } from '@/components/ui'
import { useToast } from '@/components/overlay'
import { addDays, formatDateBR } from '@/lib/dates'
import { downloadFile } from '@/lib/hooks'

export default function ReportsPage() {
  const data = useData()
  const { today } = useStore()
  const { alerts } = useAlerts()
  const toast = useToast()
  const [kind, setKind] = useState<ReportKind>('cashflow')
  const [start, setStart] = useState(addDays(today, -30))
  const [end, setEnd] = useState(addDays(today, 30))
  const invalid = start > end

  const report = useMemo(
    () => (invalid ? null : buildReport(kind, data, start, end, today, alerts)),
    [kind, data, start, end, today, alerts, invalid],
  )
  const generatedAt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })

  return (
    <>
      <div className="no-print">
        <PageHeader meta={<p className="eyebrow">Relatórios</p>} title="Relatórios" description="Gere, confira a prévia e exporte. Os arquivos são montados no seu navegador, apenas com os dados desta empresa." />
        <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-line-soft bg-surface p-4">
          <div className="min-w-60 flex-1">
            <Field label="Relatório" htmlFor="r-kind">
              <Select id="r-kind" value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
                {(Object.keys(REPORT_LABELS) as ReportKind[]).map((k) => (
                  <option key={k} value={k}>
                    {REPORT_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {report?.period !== null && (
            <>
              <Field label="De" htmlFor="r-start" error={invalid ? 'Início após o fim' : undefined}>
                <Input id="r-start" type="date" value={start} invalid={invalid} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field label="Até" htmlFor="r-end">
                <Input id="r-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </Field>
            </>
          )}
          <div className="flex gap-2">
            <Button
              icon="download"
              disabled={!report || !report.rows.length}
              onClick={() => {
                if (!report) return
                downloadFile(`nexo-${kind}-${today}.csv`, toCSV([[report.title], [`Gerado em ${generatedAt}`], ...(report.period ? [[`Período ${formatDateBR(report.period.start)} a ${formatDateBR(report.period.end)}`]] : []), [], ...reportToTable(report)]))
                toast('CSV gerado')
              }}
            >
              CSV
            </Button>
            <Button icon="report" disabled={!report || !report.rows.length} onClick={() => window.print()}>
              PDF / Imprimir
            </Button>
          </div>
        </div>
      </div>

      {report && (
        <article className="print-area overflow-hidden rounded-lg border border-line-soft bg-surface">
          <header className="border-b border-line-soft px-5 py-4">
            <p className="print-only mb-2 text-xs">Nexo Finance</p>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{report.title}</h2>
              {data.company.isDemo && <Tag tone="warn">Dados fictícios de demonstração</Tag>}
            </div>
            <p className="mt-1 text-xs text-ink-3">
              {data.company.name}
              {report.period && ` · Período ${formatDateBR(report.period.start)} a ${formatDateBR(report.period.end)}`} · Gerado em {generatedAt}
            </p>
            <p className="mt-2 text-xs text-ink-2">{report.note}</p>
          </header>
          {report.rows.length === 0 ? (
            <EmptyState title="Sem dados para este relatório" icon="report">
              Ajuste o período ou o tipo de relatório.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-line-soft text-2xs tracking-wider text-ink-3 uppercase">
                    {report.columns.map((c) => (
                      <th key={c.key} className={cx('px-5 py-2.5 font-medium', c.align === 'right' ? 'text-right' : 'text-left')}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {report.rows.slice(0, 500).map((r, i) => (
                    <tr key={i}>
                      {report.columns.map((c) => (
                        <td
                          key={c.key}
                          className={cx(
                            'px-5 py-2',
                            c.align === 'right' ? 'num text-right whitespace-nowrap' : 'text-ink-2',
                            c.money && typeof r[c.key] === 'number' && (r[c.key] as number) < 0 && 'text-risk',
                          )}
                        >
                          {formatCell(c, r[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {report.totals && (
                  <tfoot>
                    <tr className="border-t border-line font-semibold">
                      {report.columns.map((c, i) => (
                        <td key={c.key} className={cx('px-5 py-2.5', c.align === 'right' && 'num text-right')}>
                          {i === 0 ? 'Total' : c.key in report.totals! ? formatCell(c, report.totals![c.key]) : ''}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
              {report.rows.length > 500 && <p className="px-5 py-3 text-xs text-ink-3">Prévia limitada a 500 linhas. O CSV contém todas as {report.rows.length} linhas.</p>}
            </div>
          )}
        </article>
      )}
    </>
  )
}
