import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useData, useStore } from '@/data/store'
import {
  FIELD_LABELS,
  IMPORT_LIMITS,
  ImportFileError,
  sha256Hex,
  suggestMapping,
  summarize,
  tableFromCSVBytes,
  toTable,
  validateFileMeta,
  validateRows,
  type ColumnMapping,
  type ImportField,
  type ImportRowResult,
  type RawTable,
} from '@/domain/import/pipeline'
import { toCSV } from '@/domain/import/csv'
import { Button, EmptyState, Field, Money, Notice, PageHeader, Panel, Select, Tag, cx } from '@/components/ui'
import { ConfirmDialog, useToast } from '@/components/overlay'
import { Icon } from '@/components/icons'
import { formatDateBR } from '@/lib/dates'
import { downloadFile } from '@/lib/hooks'

type Step = 'select' | 'map' | 'review' | 'done'
const STEPS: { id: Step; label: string }[] = [
  { id: 'select', label: 'Arquivo' },
  { id: 'map', label: 'Colunas' },
  { id: 'review', label: 'Revisão' },
  { id: 'done', label: 'Resumo' },
]
const FIELDS: ImportField[] = ['date', 'dueDate', 'settledDate', 'description', 'amount', 'kind', 'category', 'status', 'counterparty', 'notes', 'externalId']
const PAGE = 50

interface FileInfo {
  name: string
  size: number
  hash: string
  previous: { at: string; fileName: string } | null
}

export default function ImportsPage() {
  const data = useData()
  const { today, actions } = useStore()
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('select')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<FileInfo | null>(null)
  const [table, setTable] = useState<RawTable | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping>({})
  const [accountId, setAccountId] = useState(data.accounts[0]?.id ?? '')
  const [rows, setRows] = useState<ImportRowResult[]>([])
  const [filter, setFilter] = useState<'all' | 'errors' | 'warnings' | 'dups'>('all')
  const [page, setPage] = useState(0)
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: number; warnings: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const reset = () => {
    setStep('select')
    setFile(null)
    setTable(null)
    setRows([])
    setError(null)
    setResult(null)
    setPage(0)
    if (inputRef.current) inputRef.current.value = ''
  }

  const onFile = async (f: File) => {
    setError(null)
    setBusy(true)
    try {
      validateFileMeta(f.name, f.size)
      const buf = await f.arrayBuffer()
      const hash = await sha256Hex(buf)
      let t: RawTable
      if (f.name.toLowerCase().endsWith('.xlsx')) {
        // Leitor de XLSX carregado sob demanda (fora do bundle inicial).
        const { readXlsx, XlsxError } = await import('@/domain/import/xlsx')
        try {
          t = toTable(await readXlsx(buf, IMPORT_LIMITS.maxRows))
        } catch (e) {
          if (e instanceof XlsxError) throw new ImportFileError(e.message)
          throw e
        }
      } else t = tableFromCSVBytes(new Uint8Array(buf))
      const prev = data.imports.find((i) => i.fileHash === hash)
      setFile({ name: f.name, size: f.size, hash, previous: prev ? { at: prev.at, fileName: prev.fileName } : null })
      setTable(t)
      setMapping(suggestMapping(t.headers))
      setStep('map')
    } catch (e) {
      setError(e instanceof ImportFileError ? e.message : 'Não foi possível ler o arquivo. Verifique se é um CSV ou XLSX válido.')
    } finally {
      setBusy(false)
    }
  }

  const mappingIssues = useMemo(() => {
    const issues: string[] = []
    if (mapping.amount === undefined) issues.push('Mapeie a coluna de valor.')
    if (mapping.date === undefined && mapping.dueDate === undefined && mapping.settledDate === undefined) issues.push('Mapeie ao menos uma coluna de data.')
    if (mapping.description === undefined && mapping.counterparty === undefined) issues.push('Mapeie a descrição ou o cliente/fornecedor.')
    return issues
  }, [mapping])

  const runValidation = () => {
    if (!table) return
    const r = validateRows(table, mapping, { categories: data.categories, existing: data.transactions, asOf: today })
    setRows(r)
    setPage(0)
    setFilter('all')
    setStep('review')
  }

  const summary = useMemo(() => summarize(rows), [rows])
  const visible = rows.filter((r) =>
    filter === 'errors' ? r.errors.length : filter === 'warnings' ? r.tx && r.warnings.length : filter === 'dups' ? r.alreadyImported || r.possibleDuplicateOf : true,
  )

  const doImport = async () => {
    if (!file) return
    const selected = rows.filter((r) => r.include && r.tx)
    const rec = await actions.importTransactions(
      selected.map((r) => ({ ...r.tx!, accountId })),
      {
        fileName: file.name,
        fileHash: file.hash,
        totalRows: rows.length,
        imported: selected.length,
        skipped: rows.length - selected.length - summary.withErrors,
        errors: summary.withErrors,
        warnings: summary.withWarnings,
      },
    )
    setResult({ imported: rec.imported, skipped: rec.skipped, errors: rec.errors, warnings: rec.warnings })
    setStep('done')
    toast(`${rec.imported} lançamento(s) importado(s)`)
  }

  const stepIdx = STEPS.findIndex((s) => s.id === step)

  return (
    <>
      <PageHeader
        meta={<p className="eyebrow">Importações</p>}
        title="Importar planilha"
        description="CSV ou Excel (.xlsx). O sistema sugere o mapeamento das colunas, aponta erros linha a linha e evita importar duas vezes o mesmo conteúdo."
        actions={
          <Button
            variant="ghost"
            icon="download"
            onClick={() =>
              downloadFile(
                'modelo-importacao-nexo.csv',
                toCSV([
                  ['Data', 'Descrição', 'Valor', 'Tipo', 'Categoria', 'Situação', 'Vencimento', 'Data de pagamento', 'Cliente/Fornecedor', 'Documento'],
                  ['01/10/2026', 'Venda balcão', '1.250,50', 'Receita', 'Vendas em dinheiro e Pix', 'Recebido', '01/10/2026', '01/10/2026', '', ''],
                  ['05/10/2026', 'Aluguel', '4.800,00', 'Despesa', 'Aluguel', 'Pendente', '05/11/2026', '', 'Imobiliária', 'BOL-123'],
                ]),
              )
            }
          >
            Baixar modelo CSV
          </Button>
        }
      />

      <ol className="mb-6 flex flex-wrap items-center gap-2 text-xs" aria-label="Etapas da importação">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            <span
              aria-current={i === stepIdx ? 'step' : undefined}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
                i === stepIdx ? 'border-ink/40 text-ink' : i < stepIdx ? 'border-line text-ink-2' : 'border-line-soft text-ink-3',
              )}
            >
              <span className="num">{i + 1}</span> {s.label}
            </span>
            {i < STEPS.length - 1 && <span className="h-px w-4 bg-line" />}
          </li>
        ))}
      </ol>

      {step === 'select' && (
        <Panel>
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
              'flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-6 py-12 text-center transition-colors',
              dragOver ? 'border-accent bg-accent-soft' : 'border-line hover:border-ink-3',
            )}
          >
            <Icon name="upload" size={22} className="mb-3 text-ink-3" />
            <span className="text-sm font-medium text-ink">{busy ? 'Lendo arquivo…' : 'Arraste o arquivo aqui ou clique para escolher'}</span>
            <span className="mt-1 text-xs text-ink-3">
              .csv ou .xlsx · até {IMPORT_LIMITS.maxBytes / 1024 / 1024} MB · até {IMPORT_LIMITS.maxRows.toLocaleString('pt-BR')} linhas · UTF-8 ou Windows-1252 · separador vírgula ou ponto e vírgula
            </span>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
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
            O arquivo é lido no seu navegador e nunca é executado: fórmulas são lidas pelo valor, macros são ignoradas. No modo de demonstração nada é enviado a servidores.
          </p>
        </Panel>
      )}

      {step === 'map' && table && file && (
        <Panel
          eyebrow={`${file.name} · ${table.rows.length} linha(s)${table.encoding ? ` · ${table.encoding}` : ''}${table.delimiter ? ` · separador "${table.delimiter === '\t' ? 'tab' : table.delimiter}"` : ''}`}
          title="Confira o mapeamento das colunas"
          actions={
            <Button size="sm" variant="ghost" onClick={reset}>
              Trocar arquivo
            </Button>
          }
        >
          {file.previous && (
            <Notice tone="warn" title="Este arquivo já foi importado" className="mb-4">
              Conteúdo idêntico importado em {new Date(file.previous.at).toLocaleString('pt-BR')}. Linhas já importadas serão desmarcadas automaticamente na revisão.
            </Notice>
          )}
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((f) => {
              const col = mapping[f]
              const sample = col !== undefined ? table.rows.find((r) => r[col] != null && String(r[col]).trim() !== '')?.[col] : undefined
              return (
                <Field key={f} label={FIELD_LABELS[f]} htmlFor={`map-${f}`} hint={sample !== undefined ? `Ex.: ${String(sample).slice(0, 40)}` : undefined}>
                  <Select
                    id={`map-${f}`}
                    value={col ?? ''}
                    onChange={(e) => {
                      const v = e.target.value === '' ? undefined : Number(e.target.value)
                      setMapping((m) => {
                        const next = { ...m }
                        // Cada coluna só pode alimentar um campo.
                        for (const k of Object.keys(next) as ImportField[]) if (next[k] === v) delete next[k]
                        if (v === undefined) delete next[f]
                        else next[f] = v
                        return next
                      })
                    }}
                  >
                    <option value="">Não importar</option>
                    {table.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </Field>
              )
            })}
            <Field label="Conta de destino" htmlFor="map-account">
              <Select id="map-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-4 rounded-md border border-line-soft bg-surface-2/50 p-3 text-xs text-ink-2">
            <p>
              <strong className="text-ink">Regras:</strong> sem coluna de tipo, valores negativos viram despesa e positivos, receita. Sem coluna de situação, datas futuras viram pendentes e
              passadas, liquidadas (com aviso). Categorias inexistentes ficam em branco — nada é criado automaticamente.
            </p>
          </div>
          {mappingIssues.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-warn">
              {mappingIssues.map((i) => (
                <li key={i}>· {i}</li>
              ))}
            </ul>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="primary" disabled={mappingIssues.length > 0} onClick={runValidation}>
              Validar linhas
            </Button>
          </div>
        </Panel>
      )}

      {step === 'review' && file && (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line-soft bg-line-soft text-sm sm:grid-cols-3 lg:grid-cols-6">
            <Count label="Linhas lidas" value={summary.total} />
            <Count label="Válidas" value={summary.valid} tone="pos" />
            <Count label="Com aviso" value={summary.withWarnings} tone={summary.withWarnings ? 'warn' : undefined} />
            <Count label="Com erro" value={summary.withErrors} tone={summary.withErrors ? 'risk' : undefined} />
            <Count label="Já importadas" value={summary.alreadyImported} />
            <Count label="Possíveis duplicatas" value={summary.possibleDuplicates} tone={summary.possibleDuplicates ? 'warn' : undefined} />
          </dl>
          <Panel
            eyebrow={file.name}
            title={`${summary.selected} lançamento(s) selecionado(s) para importar`}
            actions={
              <>
                <Button size="sm" variant="ghost" onClick={() => setStep('map')}>
                  Voltar ao mapeamento
                </Button>
                <Button size="sm" variant="primary" disabled={summary.selected === 0} onClick={() => setConfirm(true)}>
                  Importar {summary.selected}
                </Button>
              </>
            }
            bodyClassName="p-0 sm:p-0"
          >
            <div className="flex flex-wrap gap-2 border-b border-line-soft px-4 py-2.5 sm:px-5">
              {(
                [
                  ['all', `Todas (${rows.length})`],
                  ['errors', `Erros (${summary.withErrors})`],
                  ['warnings', `Avisos (${summary.withWarnings})`],
                  ['dups', `Duplicatas (${summary.alreadyImported + summary.possibleDuplicates})`],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => {
                    setFilter(k)
                    setPage(0)
                  }}
                  className={cx('rounded px-2 py-1 text-xs', filter === k ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink')}
                >
                  {l}
                </button>
              ))}
            </div>
            {visible.length === 0 ? (
              <EmptyState title="Nenhuma linha neste filtro" icon="check" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-line-soft text-left text-2xs tracking-wider text-ink-3 uppercase">
                      <th className="w-10 px-4 py-2.5 sm:px-5">
                        <span className="sr-only">Importar</span>
                      </th>
                      <th className="px-2 py-2.5 font-medium">Linha</th>
                      <th className="px-2 py-2.5 font-medium">Data</th>
                      <th className="px-2 py-2.5 font-medium">Descrição</th>
                      <th className="px-2 py-2.5 text-right font-medium">Valor</th>
                      <th className="px-4 py-2.5 font-medium sm:px-5">Mensagens</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {visible.slice(page * PAGE, page * PAGE + PAGE).map((r) => (
                      <tr key={r.index} className={cx(!r.include && 'text-ink-3')}>
                        <td className="px-4 py-2 sm:px-5">
                          <input
                            type="checkbox"
                            aria-label={`Importar linha ${r.index}`}
                            checked={r.include}
                            disabled={!r.tx}
                            onChange={(e) => setRows((all) => all.map((x) => (x.index === r.index ? { ...x, include: e.target.checked } : x)))}
                            className="h-4 w-4 accent-[#c9d5e8]"
                          />
                        </td>
                        <td className="num px-2 py-2 text-ink-3">{r.index}</td>
                        <td className="num px-2 py-2 whitespace-nowrap">{r.tx ? formatDateBR(r.tx.competenceDate) : '—'}</td>
                        <td className="max-w-56 truncate px-2 py-2">{r.tx?.description ?? r.raw.filter(Boolean).join(' · ').slice(0, 80)}</td>
                        <td className="px-2 py-2 text-right">{r.tx ? <Money value={r.tx.kind === 'expense' ? -r.tx.amount : r.tx.amount} signed className={r.tx.kind === 'income' ? 'text-pos' : ''} /> : '—'}</td>
                        <td className="px-4 py-2 text-xs sm:px-5">
                          {r.errors.map((m) => (
                            <span key={m} className="block text-risk">
                              {m}
                            </span>
                          ))}
                          {r.warnings.map((m) => (
                            <span key={m} className="block text-warn/85">
                              {m}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {visible.length > PAGE && (
                  <div className="flex items-center justify-between border-t border-line-soft px-5 py-2.5 text-xs text-ink-3">
                    <span>
                      {page * PAGE + 1}–{Math.min(visible.length, (page + 1) * PAGE)} de {visible.length}
                    </span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                        Anterior
                      </Button>
                      <Button size="sm" variant="ghost" disabled={(page + 1) * PAGE >= visible.length} onClick={() => setPage((p) => p + 1)}>
                        Próxima
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Panel>
          <ConfirmDialog
            open={confirm}
            title={`Importar ${summary.selected} lançamento(s)?`}
            description={`Os lançamentos entram na conta "${data.accounts.find((a) => a.id === accountId)?.name}" e passam a compor saldos, projeções e alertas. ${summary.withErrors} linha(s) com erro não serão importadas.`}
            confirmLabel="Importar"
            onClose={() => setConfirm(false)}
            onConfirm={doImport}
          />
        </>
      )}

      {step === 'done' && result && (
        <Panel eyebrow="Importação concluída" title={`${result.imported} lançamento(s) importado(s)`}>
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <Count label="Importados" value={result.imported} tone="pos" plain />
            <Count label="Não selecionados" value={result.skipped} plain />
            <Count label="Com erro (não importados)" value={result.errors} tone={result.errors ? 'risk' : undefined} plain />
            <Count label="Importados com aviso" value={result.warnings} tone={result.warnings ? 'warn' : undefined} plain />
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link to="/app/movimentacoes" className="link text-sm">
              Ver movimentações
            </Link>
            <span className="text-ink-3">·</span>
            <button onClick={reset} className="link text-sm">
              Importar outro arquivo
            </button>
          </div>
        </Panel>
      )}

      <Panel className="mt-6" eyebrow="Histórico" title="Importações anteriores" bodyClassName="p-0 sm:p-0">
        {data.imports.length === 0 ? (
          <p className="px-5 py-5 text-sm text-ink-3">Nenhuma importação realizada.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-line-soft text-left text-2xs tracking-wider text-ink-3 uppercase">
                  <th className="px-5 py-2.5 font-medium">Quando</th>
                  <th className="px-3 py-2.5 font-medium">Arquivo</th>
                  <th className="px-3 py-2.5 font-medium">Responsável</th>
                  <th className="px-5 py-2.5 text-right font-medium">Resultado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {data.imports.map((i) => (
                  <tr key={i.id}>
                    <td className="num px-5 py-2 text-ink-2">{new Date(i.at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td>
                    <td className="max-w-60 truncate px-3 py-2">
                      {i.fileName} <span className="num text-2xs text-ink-3">#{i.fileHash.slice(0, 8)}</span>
                    </td>
                    <td className="px-3 py-2 text-ink-2">{i.actor}</td>
                    <td className="px-5 py-2 text-right">
                      <Tag tone="pos">{i.imported} importados</Tag> {i.errors > 0 && <Tag tone="risk">{i.errors} erros</Tag>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  )
}

function Count({ label, value, tone, plain }: { label: string; value: number; tone?: 'pos' | 'warn' | 'risk'; plain?: boolean }) {
  const color = tone === 'pos' ? 'text-pos' : tone === 'warn' ? 'text-warn' : tone === 'risk' ? 'text-risk' : 'text-ink'
  return (
    <div className={plain ? '' : 'bg-surface px-4 py-3'}>
      <dt className="text-2xs text-ink-3">{label}</dt>
      <dd className={cx('num mt-0.5 text-lg font-semibold', color)}>{value}</dd>
    </div>
  )
}
