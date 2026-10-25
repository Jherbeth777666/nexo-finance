import type { Account, Category } from '@/domain/types'
import { validateTransaction, type TransactionInput, type ValidTransaction } from '@/domain/transactions'
import { isISODate, type ISODate } from '@/lib/dates'
import { IMPORT_LIMITS } from './pipeline'

/**
 * Validação do lote recebido pela Edge Function de importação. Pura e compartilhada com os testes:
 * a Edge Function nunca confia no cliente e reaproveita as MESMAS regras do domínio.
 * As mensagens são nossas (nunca detalhes internos do banco) e os erros são por linha do arquivo.
 */

export interface ImportValidationContext {
  accounts: Pick<Account, 'id'>[]
  categories: Category[]
  /** Hoje no fuso da empresa (nunca a data UTC do servidor). */
  today: ISODate
}

export interface ImportBatchError {
  line: number
  message: string
}

export type ImportBatchValidation = { ok: true; value: ValidTransaction[] } | { ok: false; errors: ImportBatchError[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const optionalText = (v: unknown): v is string | null | undefined => v == null || typeof v === 'string'

/** Centavos inteiros → texto numérico com ponto decimal, exatamente como parseMoney entende. */
function centsToInput(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function validateImportBatch(rawRows: unknown, ctx: ImportValidationContext): ImportBatchValidation {
  if (!Array.isArray(rawRows)) return { ok: false, errors: [{ line: 0, message: 'Lote de importação inválido.' }] }
  if (rawRows.length === 0) return { ok: false, errors: [{ line: 0, message: 'Nenhuma linha para importar.' }] }
  if (rawRows.length > IMPORT_LIMITS.maxRows) {
    return { ok: false, errors: [{ line: 0, message: `O limite por importação é ${IMPORT_LIMITS.maxRows} linhas.` }] }
  }

  const value: ValidTransaction[] = []
  const errors: ImportBatchError[] = []

  rawRows.forEach((raw, i) => {
    const line = i + 2
    if (!isRecord(raw)) {
      errors.push({ line, message: 'Linha inválida.' })
      return
    }

    const rowErrors: string[] = []
    const kind = raw.kind
    const status = raw.status
    const description = raw.description
    const accountId = raw.accountId
    const amount = raw.amount
    const competenceDate = raw.competenceDate
    const dueDate = raw.dueDate
    const settledDate = raw.settledDate
    const categoryId = raw.categoryId
    const counterparty = raw.counterparty
    const notes = raw.notes
    const sourceRef = raw.sourceRef

    if (kind !== 'income' && kind !== 'expense') rowErrors.push('Tipo inválido para importação.')
    if (status !== 'pending' && status !== 'settled' && status !== 'cancelled') rowErrors.push('Situação inválida.')
    if (!isText(description)) rowErrors.push('Descrição inválida.')
    if (!isText(accountId)) rowErrors.push('Conta inválida.')
    if (!isText(competenceDate) || !isISODate(competenceDate)) rowErrors.push('Data de competência inválida.')
    if (!isText(dueDate) || !isISODate(dueDate)) rowErrors.push('Data de vencimento inválida.')
    if (settledDate !== null && settledDate !== undefined && (!isText(settledDate) || !isISODate(settledDate))) rowErrors.push('Data de liquidação inválida.')
    if (!optionalText(categoryId)) rowErrors.push('Categoria inválida.')
    if (!optionalText(counterparty)) rowErrors.push('Cliente/fornecedor inválido.')
    if (!optionalText(notes)) rowErrors.push('Observações inválidas.')
    if (!optionalText(sourceRef)) rowErrors.push('Identificador de origem inválido.')

    if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) rowErrors.push('Valor inválido.')
    else if (amount < 0) rowErrors.push('O valor deve ser maior que zero.')

    if (isText(counterparty) && counterparty.trim().length > 120) rowErrors.push('Cliente/fornecedor com mais de 120 caracteres.')
    if (isText(sourceRef) && sourceRef.length > 300) rowErrors.push('Identificador de origem com mais de 300 caracteres.')

    if (rowErrors.length) {
      errors.push({ line, message: rowErrors.join(' ') })
      return
    }

    const input: TransactionInput = {
      kind: kind as TransactionInput['kind'],
      status: status as TransactionInput['status'],
      description: (description as string).trim(),
      counterparty: typeof counterparty === 'string' ? counterparty.trim() : '',
      categoryId: typeof categoryId === 'string' ? categoryId : '',
      accountId: accountId as string,
      toAccountId: '',
      amount: centsToInput(amount as number),
      competenceDate: competenceDate as string,
      dueDate: dueDate as string,
      settledDate: typeof settledDate === 'string' ? settledDate : '',
      notes: typeof notes === 'string' ? notes : '',
    }
    const validated = validateTransaction(input, ctx)
    if (!validated.ok) {
      const messages = Object.values(validated.errors).filter((m): m is string => !!m)
      errors.push({ line, message: messages.join(' ') })
      return
    }
    value.push({ ...validated.value, sourceRef: typeof sourceRef === 'string' && sourceRef.trim() ? sourceRef : undefined })
  })

  if (errors.length) return { ok: false, errors }
  return { ok: true, value }
}
