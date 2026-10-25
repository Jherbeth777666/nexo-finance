import type { Category, Transaction, TxKind, TxStatus } from '@/domain/types'
import { parseMoney, type Cents } from '@/lib/money'
import { parseDateFlexible, type ISODate } from '@/lib/dates'
import { parseCSV, detectDelimiter, type Delimiter } from './csv'
import type { Cell } from './xlsx'

export const IMPORT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 5_000,
  extensions: ['.csv', '.xlsx'] as const,
}

export type ImportField =
  'date' | 'dueDate' | 'settledDate' | 'description' | 'amount' | 'kind' | 'category' | 'status' | 'counterparty' | 'notes' | 'externalId'

export const FIELD_LABELS: Record<ImportField, string> = {
  date: 'Data (competência)',
  dueDate: 'Vencimento',
  settledDate: 'Data de pagamento/recebimento',
  description: 'Descrição',
  amount: 'Valor',
  kind: 'Tipo (receita/despesa)',
  category: 'Categoria',
  status: 'Situação',
  counterparty: 'Cliente/Fornecedor',
  notes: 'Observações',
  externalId: 'Identificador de origem',
}

const SYNONYMS: Record<ImportField, string[]> = {
  date: ['data', 'data lancamento', 'data do lancamento', 'competencia', 'data competencia', 'dt', 'date', 'emissao', 'data emissao'],
  dueDate: ['vencimento', 'data vencimento', 'data de vencimento', 'vence em', 'dt vencimento', 'due date', 'venc'],
  settledDate: [
    'pagamento',
    'data pagamento',
    'data de pagamento',
    'recebimento',
    'data recebimento',
    'liquidacao',
    'data liquidacao',
    'baixa',
    'data baixa',
    'pago em',
    'quitacao',
  ],
  description: ['descricao', 'historico', 'descricao do lancamento', 'lancamento', 'item', 'description', 'memo', 'detalhe'],
  amount: ['valor', 'valor r$', 'valor rs', 'montante', 'amount', 'total', 'valor total', 'quantia', 'vlr'],
  kind: ['tipo', 'natureza', 'entrada saida', 'e s', 'credito debito', 'operacao', 'type', 'movimento'],
  category: ['categoria', 'plano de contas', 'classificacao', 'conta', 'centro de custo', 'category', 'grupo'],
  status: ['situacao', 'status', 'estado', 'pago', 'quitado'],
  counterparty: ['cliente', 'fornecedor', 'favorecido', 'cliente fornecedor', 'contraparte', 'pagador', 'beneficiario', 'nome', 'razao social'],
  notes: ['observacao', 'observacoes', 'obs', 'notas', 'comentario', 'notes'],
  externalId: ['id', 'codigo', 'documento', 'numero documento', 'nf', 'nota fiscal', 'doc', 'n documento', 'identificador'],
}

export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9$]+/g, ' ')
    .trim()

export type ColumnMapping = Partial<Record<ImportField, number>>

/** Sugere o mapeamento por sinônimos; cada coluna é usada no máximo uma vez. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {}
  const used = new Set<number>()
  const normalized = headers.map(norm)
  const fields = Object.keys(SYNONYMS) as ImportField[]
  // 1ª passada: correspondência exata; 2ª: contém o sinônimo.
  for (const pass of ['exact', 'partial'] as const) {
    for (const field of fields) {
      if (mapping[field] !== undefined) continue
      const idx = normalized.findIndex(
        (h, i) => !used.has(i) && SYNONYMS[field].some((syn) => (pass === 'exact' ? h === syn : h.split(' ').length <= 4 && ` ${h} `.includes(` ${syn} `))),
      )
      if (idx >= 0) {
        mapping[field] = idx
        used.add(idx)
      }
    }
  }
  return mapping
}

export interface RawTable {
  headers: string[]
  rows: Cell[][]
  delimiter?: Delimiter
  encoding?: string
}

export class ImportFileError extends Error {}

export function validateFileMeta(name: string, size: number) {
  const lower = name.toLowerCase()
  if (!IMPORT_LIMITS.extensions.some((e) => lower.endsWith(e))) throw new ImportFileError('Formato não suportado. Envie um arquivo .csv ou .xlsx.')
  if (size === 0) throw new ImportFileError('O arquivo está vazio.')
  if (size > IMPORT_LIMITS.maxBytes) throw new ImportFileError(`O arquivo excede o limite de ${IMPORT_LIMITS.maxBytes / 1024 / 1024} MB.`)
}

/** Decodifica texto tentando UTF-8 estrito e caindo para Windows-1252 (comum em exportações brasileiras). */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' }
  }
}

export function tableFromCSVBytes(bytes: Uint8Array): RawTable {
  if (bytes.subarray(0, 4).every((b, i) => b === [0x50, 0x4b, 0x03, 0x04][i]))
    throw new ImportFileError('Este arquivo parece ser uma planilha Excel com extensão .csv. Renomeie para .xlsx.')
  if (bytes.subarray(0, 8192).includes(0)) throw new ImportFileError('O arquivo contém dados binários e não é um CSV válido.')
  const { text, encoding } = decodeText(bytes)
  const delimiter = detectDelimiter(text)
  const all = parseCSV(text, delimiter)
  return toTable(all, { delimiter, encoding })
}

export function toTable(all: Cell[][], meta: Partial<RawTable> = {}): RawTable {
  if (all.length < 2) throw new ImportFileError('O arquivo precisa de uma linha de cabeçalho e ao menos uma linha de dados.')
  if (all.length - 1 > IMPORT_LIMITS.maxRows)
    throw new ImportFileError(`O arquivo tem ${all.length - 1} linhas. O limite por importação é ${IMPORT_LIMITS.maxRows}.`)
  const headers = all[0].map((h, i) => (h == null || String(h).trim() === '' ? `Coluna ${i + 1}` : String(h).trim()))
  return { headers, rows: all.slice(1), ...meta }
}

export interface ImportRowResult {
  index: number // número da linha no arquivo (1 = cabeçalho)
  raw: Cell[]
  tx: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt' | 'importId' | 'accountId' | 'source'> | null
  errors: string[]
  warnings: string[]
  /** Já importada antes (mesmo identificador de origem): ignorada por padrão. */
  alreadyImported: boolean
  /** Lançamento existente parecido: só sinaliza, a decisão é do usuário. */
  possibleDuplicateOf: string | null
  include: boolean
}

const KIND_IN = ['receita', 'entrada', 'credito', 'c', 'recebimento', 'r', 'income', 'venda']
const KIND_OUT = ['despesa', 'saida', 'debito', 'd', 'pagamento', 'custo', 'expense', 'compra']
const STATUS_SETTLED = ['pago', 'paga', 'recebido', 'recebida', 'liquidado', 'quitado', 'quitada', 'baixado', 'sim', 's', 'realizado', 'ok']
const STATUS_PENDING = ['pendente', 'aberto', 'em aberto', 'a vencer', 'a pagar', 'a receber', 'nao', 'n', 'previsto', 'agendado', 'vencido']
const STATUS_CANCELLED = ['cancelado', 'cancelada', 'estornado']

const cellStr = (c: Cell | undefined) => (c == null ? '' : String(c).trim())

/** Identificador estável de uma linha importada (para reimportação idempotente entre arquivos diferentes). */
export function rowSourceRef(tx: { kind: TxKind; amount: Cents; competenceDate: ISODate; description: string }, externalId?: string) {
  if (externalId) return `ext:${norm(externalId)}`
  return `row:${tx.kind}|${tx.amount}|${tx.competenceDate}|${norm(tx.description)}`
}

export function validateRows(
  table: RawTable,
  mapping: ColumnMapping,
  ctx: { categories: Category[]; existing: Transaction[]; asOf: ISODate },
): ImportRowResult[] {
  const catByName = new Map(ctx.categories.map((c) => [norm(c.name), c]))
  const existingRefs = new Set(ctx.existing.map((t) => t.sourceRef).filter(Boolean))
  const existingKeys = new Map<string, string>()
  for (const t of ctx.existing) existingKeys.set(`${t.kind}|${t.amount}|${t.competenceDate}`, t.id)
  const seenInFile = new Map<string, { line: number; count: number }>()

  return table.rows.map((raw, i) => {
    const errors: string[] = []
    const warnings: string[] = []
    const get = (f: ImportField) => (mapping[f] === undefined ? undefined : raw[mapping[f]!])

    const amountRaw = get('amount')
    const parsedAmount = amountRaw == null || cellStr(amountRaw) === '' ? null : parseMoney(amountRaw)
    if (mapping.amount === undefined) errors.push('Coluna de valor não mapeada')
    else if (amountRaw == null || cellStr(amountRaw) === '') errors.push('Valor vazio')
    else if (parsedAmount === null) errors.push(`Valor inválido: "${cellStr(amountRaw)}"`)
    else if (parsedAmount === 0) errors.push('Valor igual a zero')

    let kind: TxKind | null = null
    const kindRaw = norm(cellStr(get('kind')))
    if (kindRaw) {
      if (KIND_IN.includes(kindRaw)) kind = 'income'
      else if (KIND_OUT.includes(kindRaw)) kind = 'expense'
      else errors.push(`Tipo não reconhecido: "${cellStr(get('kind'))}"`)
    } else if (parsedAmount !== null && parsedAmount !== 0) {
      kind = parsedAmount < 0 ? 'expense' : 'income'
      warnings.push(parsedAmount < 0 ? 'Tipo inferido pelo sinal: despesa' : 'Tipo inferido pelo sinal: receita')
    }

    const parseDateField = (f: ImportField): ISODate | null | 'invalid' => {
      const v = get(f)
      if (v == null || cellStr(v) === '') return null
      return parseDateFlexible(v) ?? 'invalid'
    }
    const date = parseDateField('date')
    const due = parseDateField('dueDate')
    const settled = parseDateField('settledDate')
    for (const [f, v] of [
      ['date', date],
      ['dueDate', due],
      ['settledDate', settled],
    ] as const) {
      if (v === 'invalid') errors.push(`${FIELD_LABELS[f]} inválida: "${cellStr(get(f))}"`)
    }
    const validDate = (v: ISODate | null | 'invalid') => (v && v !== 'invalid' ? v : null)
    const competenceDate = validDate(date) ?? validDate(due) ?? validDate(settled)
    if (!competenceDate && !errors.some((e) => e.includes('inválida'))) errors.push('Nenhuma data informada')

    const description = cellStr(get('description')) || cellStr(get('counterparty'))
    if (!description) errors.push('Descrição vazia')
    if (description.length > 200) warnings.push('Descrição truncada em 200 caracteres')

    let status: TxStatus
    const statusRaw = norm(cellStr(get('status')))
    if (statusRaw && STATUS_CANCELLED.includes(statusRaw)) status = 'cancelled'
    else if (statusRaw && STATUS_SETTLED.includes(statusRaw)) status = 'settled'
    else if (statusRaw && STATUS_PENDING.includes(statusRaw)) status = 'pending'
    else {
      if (statusRaw) warnings.push(`Situação "${cellStr(get('status'))}" não reconhecida; inferida pelas datas`)
      if (validDate(settled)) status = 'settled'
      else if (competenceDate && (validDate(due) ?? competenceDate) > ctx.asOf) status = 'pending'
      else {
        status = 'settled'
        if (!validDate(settled)) warnings.push('Sem data de pagamento: considerado liquidado na data informada')
      }
    }
    const settledDate = status === 'settled' ? (validDate(settled) ?? validDate(due) ?? competenceDate) : null
    if (settledDate && settledDate > ctx.asOf) {
      errors.push('Data de liquidação no futuro: marque como pendente ou corrija a data')
    }

    const catRaw = cellStr(get('category'))
    let categoryId: string | null = null
    if (catRaw) {
      const cat = catByName.get(norm(catRaw))
      if (cat && kind && cat.kind !== kind) warnings.push(`Categoria "${catRaw}" é de ${cat.kind === 'income' ? 'receita' : 'despesa'}; ficará sem categoria`)
      else if (cat) categoryId = cat.id
      else warnings.push(`Categoria "${catRaw}" não existe; ficará sem categoria`)
    } else warnings.push('Sem categoria')

    if (errors.length || !kind || parsedAmount === null || !competenceDate) {
      // Linhas com erro exibem só os erros: avisos sobre dados que não serão importados confundem.
      return { index: i + 2, raw, tx: null, errors, warnings: [], alreadyImported: false, possibleDuplicateOf: null, include: false }
    }

    const amount = Math.abs(parsedAmount)
    const tx = {
      kind,
      status,
      description: description.slice(0, 200),
      counterparty: cellStr(get('counterparty')) || undefined,
      categoryId,
      amount,
      competenceDate,
      dueDate: validDate(due) ?? competenceDate,
      settledDate,
      notes: cellStr(get('notes')).slice(0, 500) || undefined,
      sourceRef: rowSourceRef({ kind, amount, competenceDate, description }, cellStr(get('externalId')) || undefined),
    }
    // Linhas idênticas no mesmo arquivo recebem sufixo (#2, #3…): cada ocorrência tem identidade
    // própria, e reimportar o arquivo continua reconhecendo todas elas.
    const seen = seenInFile.get(tx.sourceRef)
    if (seen) {
      seen.count++
      warnings.push(`Igual à linha ${seen.line} deste arquivo`)
      tx.sourceRef = `${tx.sourceRef}#${seen.count}`
    } else seenInFile.set(tx.sourceRef, { line: i + 2, count: 1 })

    const alreadyImported = existingRefs.has(tx.sourceRef)
    if (alreadyImported) warnings.push('Já importada anteriormente (mesmo identificador de origem)')
    const possibleDuplicateOf = alreadyImported ? null : (existingKeys.get(`${kind}|${amount}|${competenceDate}`) ?? null)
    if (possibleDuplicateOf) warnings.push('Existe lançamento com mesmo tipo, valor e data — pode ser duplicata')

    return {
      index: i + 2,
      raw,
      tx,
      errors,
      warnings,
      alreadyImported,
      possibleDuplicateOf,
      include: !alreadyImported,
    }
  })
}

export interface ImportSummary {
  total: number
  valid: number
  withErrors: number
  withWarnings: number
  alreadyImported: number
  possibleDuplicates: number
  selected: number
}

export function summarize(rows: ImportRowResult[]): ImportSummary {
  return {
    total: rows.length,
    valid: rows.filter((r) => r.tx).length,
    withErrors: rows.filter((r) => r.errors.length).length,
    withWarnings: rows.filter((r) => r.tx && r.warnings.length).length,
    alreadyImported: rows.filter((r) => r.alreadyImported).length,
    possibleDuplicates: rows.filter((r) => r.possibleDuplicateOf).length,
    selected: rows.filter((r) => r.include && r.tx).length,
  }
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export { parseCSV }
