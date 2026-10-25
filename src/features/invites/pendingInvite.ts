/**
 * Convite pendente guardado no navegador: sobrevive à confirmação de e-mail em outra aba.
 * O token nunca vai para a URL de redirecionamento do Supabase; fica só aqui.
 */
export const PENDING_INVITE_KEY = 'nexo.pendingInvite'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface PendingInvite {
  token: string
  savedAt: number
}

export function savePendingInvite(token: string): void {
  const value = token.trim()
  if (!value) return
  try {
    localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ token: value, savedAt: Date.now() } satisfies PendingInvite))
  } catch {
    /* armazenamento indisponível: o fluxo continua sem persistir */
  }
}

export function readPendingInvite(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_INVITE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingInvite>
    if (typeof parsed.token !== 'string' || !parsed.token || typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(PENDING_INVITE_KEY)
      return null
    }
    return parsed.token
  } catch {
    return null
  }
}

export function clearPendingInvite(): void {
  try {
    localStorage.removeItem(PENDING_INVITE_KEY)
  } catch {
    /* opcional */
  }
}
