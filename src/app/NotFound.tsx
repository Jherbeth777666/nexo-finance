import { ButtonLink, EmptyState } from '@/components/ui'

export default function NotFound({ inApp }: { inApp?: boolean }) {
  return (
    <div className={inApp ? 'py-16' : 'flex min-h-screen items-center justify-center bg-bg'}>
      <EmptyState
        title="Página não encontrada"
        action={
          <ButtonLink to={inApp ? '/app/overview' : '/'} variant="secondary">
            {inApp ? 'Voltar para a visão geral' : 'Ir para o início'}
          </ButtonLink>
        }
      >
        O endereço pode ter mudado ou não existe.
      </EmptyState>
    </div>
  )
}
