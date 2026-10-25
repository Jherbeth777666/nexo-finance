import type { Cents } from '@/lib/money'

/** Validações puras dos dados editáveis da empresa (sem dependência de interface ou banco). */

export const COMPANY_NAME_MIN = 2
export const COMPANY_NAME_MAX = 120
/** Limite compatível com numeric(14,2): até 999.999.999.999,99 em reais. */
export const OPENING_BALANCE_MAX_ABS = 99_999_999_999_999

export type CompanyValidation<T> = { ok: true; value: T } | { ok: false; error: string }

export function validateCompanyName(raw: unknown): CompanyValidation<string> {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name.length < COMPANY_NAME_MIN || name.length > COMPANY_NAME_MAX) {
    return { ok: false, error: `Use de ${COMPANY_NAME_MIN} a ${COMPANY_NAME_MAX} caracteres.` }
  }
  return { ok: true, value: name }
}

export function validateOpeningBalance(value: unknown): CompanyValidation<Cents> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > OPENING_BALANCE_MAX_ABS) {
    return { ok: false, error: 'Saldo de abertura inválido.' }
  }
  return { ok: true, value }
}
