import type { Cents } from '@/lib/money'
import type { InviteRole } from './types'

/** Validações puras dos dados editáveis da empresa (sem dependência de interface ou banco). */

export const COMPANY_NAME_MIN = 2
export const COMPANY_NAME_MAX = 120
/** Limite compatível com numeric(14,2): até 999.999.999.999,99 em reais. */
export const OPENING_BALANCE_MAX_ABS = 99_999_999_999_999
export const INVITE_EMAIL_MAX = 254
export const INVITE_ROLES: readonly InviteRole[] = ['admin', 'member', 'viewer']

export type CompanyValidation<T> = { ok: true; value: T } | { ok: false; error: string }

const INVITE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

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

/** Normaliza (espaços e maiúsculas) e valida o e-mail do convidado. */
export function validateInviteEmail(raw: unknown): CompanyValidation<string> {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!email || email.length > INVITE_EMAIL_MAX || !INVITE_EMAIL_RE.test(email)) {
    return { ok: false, error: 'Informe um e-mail válido.' }
  }
  return { ok: true, value: email }
}

/** O dono da empresa não é transferido por convite: só admin, member ou viewer. */
export function validateInviteRole(raw: unknown): CompanyValidation<InviteRole> {
  if (typeof raw !== 'string' || !INVITE_ROLES.includes(raw as InviteRole)) {
    return { ok: false, error: 'Papel inválido. Use administrador, membro ou somente leitura.' }
  }
  return { ok: true, value: raw as InviteRole }
}
