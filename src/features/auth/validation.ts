export interface SignupInput {
  name: string
  company: string
  email: string
  password: string
  confirm: string
}

export type AuthErrors = Partial<Record<keyof SignupInput, string>>

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function validateEmail(email: string): string | undefined {
  const e = email.trim()
  if (!e) return 'Informe o e-mail'
  if (e.length > 254 || !EMAIL_RE.test(e)) return 'E-mail inválido'
}

export function validatePassword(p: string): string | undefined {
  if (p.length < 10) return 'Use ao menos 10 caracteres'
  if (p.length > 128) return 'Máximo de 128 caracteres'
  if (!/[a-zA-Z]/.test(p) || !/\d/.test(p)) return 'Combine letras e números'
}

export function validateLogin(i: { email: string; password: string }): AuthErrors {
  const e: AuthErrors = {}
  const em = validateEmail(i.email)
  if (em) e.email = em
  if (!i.password) e.password = 'Informe a senha'
  return e
}

export function validateSignup(i: SignupInput): AuthErrors {
  const e: AuthErrors = {}
  if (i.name.trim().length < 2) e.name = 'Informe seu nome'
  if (i.company.trim().length < 2) e.company = 'Informe o nome da empresa'
  const em = validateEmail(i.email)
  if (em) e.email = em
  const pw = validatePassword(i.password)
  if (pw) e.password = pw
  if (i.confirm !== i.password) e.confirm = 'As senhas não coincidem'
  return e
}
