import { useEffect, useMemo } from 'react'
import { Link } from 'react-router'
import { Icon, Logo } from '@/components/icons'
import { ButtonLink, Money, SeverityTag, Tag } from '@/components/ui'
import { ProjectionChart } from '@/components/charts'
import { buildDemoDataset } from '@/data/demo/seed'
import { detectAlerts } from '@/domain/finance/alerts'
import { BASE_SCENARIO, projectCashflow } from '@/domain/finance/projection'
import { formatDateBR, todayIn } from '@/lib/dates'

export default function LandingPage() {
  useEffect(() => {
    document.title = 'Nexo Finance — Veja o que vem antes do problema'
  }, [])
  // A prévia usa o motor real sobre os dados fictícios da demonstração — não é uma imagem montada.
  const preview = useMemo(() => {
    const today = todayIn()
    const ds = buildDemoDataset(today)
    const p = projectCashflow({ accounts: ds.accounts, transactions: ds.transactions, asOf: today, horizonDays: 30, assumptions: BASE_SCENARIO })
    const alerts = detectAlerts(ds.accounts, ds.transactions, ds.categories, today).alerts.slice(0, 3)
    return { p, alerts, company: ds.company.name }
  }, [])

  return (
    <div className="min-h-screen bg-bg">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5" aria-label="Nexo Finance">
          <Logo />
          <span className="font-semibold tracking-tight">
            Nexo <span className="font-normal text-ink-2">Finance</span>
          </span>
        </Link>
        <nav aria-label="Página inicial" className="flex items-center gap-1 sm:gap-2">
          <a href="#como-funciona" className="hidden rounded px-3 py-2 text-sm text-ink-2 hover:text-ink sm:block">
            Como funciona
          </a>
          <a href="#seguranca" className="hidden rounded px-3 py-2 text-sm text-ink-2 hover:text-ink sm:block">
            Privacidade
          </a>
          <Link to="/login" className="rounded px-3 py-2 text-sm text-ink-2 hover:text-ink">
            Entrar
          </Link>
          <ButtonLink to="/app/overview?modo=demo" variant="primary" size="sm">
            Abrir demonstração
          </ButtonLink>
        </nav>
      </header>

      <main>
        <section className="relative mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-12 overflow-x-clip px-4 pt-14 pb-16 sm:px-6 sm:pb-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:pt-24 lg:pb-24">
          <div>
            <p className="eyebrow mb-4">Inteligência financeira para pequenas empresas</p>
            <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.4rem]">
              Veja o que vem antes do problema.
            </h1>
            <p className="mt-6 max-w-lg text-base leading-relaxed text-ink-2 sm:text-lg">
              O Nexo lê seus lançamentos e planilhas, projeta o caixa das próximas semanas e mostra o que merece atenção — com os números e as premissas de cada
              conclusão.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink to="/app/overview?modo=demo" variant="primary">
                Explorar a demonstração
                <Icon name="arrowRight" size={16} />
              </ButtonLink>
              <ButtonLink to="/cadastro" variant="secondary">
                Criar conta
              </ButtonLink>
            </div>
            <p className="mt-4 text-xs text-ink-3">A demonstração usa uma empresa fictícia e não pede cadastro.</p>
          </div>

          {/* Prévia real do produto */}
          <div className="relative">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-6 rounded-[2rem] opacity-80 blur-2xl sm:-inset-10"
              style={{
                background: 'radial-gradient(55% 55% at 62% 28%, color-mix(in srgb, var(--color-accent) 24%, transparent), transparent 72%)',
              }}
            />
            <div className="relative rounded-lg bg-gradient-to-br from-accent/40 via-line/70 to-line-soft/30 p-px shadow-2xl shadow-black/50">
              <figure className="overflow-hidden rounded-[11px] bg-surface">
                <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
                  <span className="truncate text-xs text-ink-2">{preview.company}</span>
                  <Tag tone="warn">dados fictícios</Tag>
                </div>
                <div className="grid grid-cols-1 gap-px bg-line-soft text-sm sm:grid-cols-3">
                  <div className="min-w-0 bg-surface px-4 py-3">
                    <p className="eyebrow">Saldo hoje</p>
                    <Money value={preview.p.startBalance} className="mt-1 block text-lg font-semibold sm:text-base" />
                  </div>
                  <div className="min-w-0 bg-surface px-4 py-3">
                    <p className="eyebrow">Mínimo 30 dias</p>
                    <Money value={preview.p.minBalance} tone="risk-only" className="mt-1 block text-lg font-semibold sm:text-base" />
                  </div>
                  <div className="min-w-0 bg-surface px-4 py-3">
                    <p className="eyebrow">Em {formatDateBR(preview.p.minDate).slice(0, 5)}</p>
                    <span className="mt-1 block text-lg font-semibold text-ink-2 sm:text-base">dia mais apertado</span>
                  </div>
                </div>
                <div className="px-3 pt-3">
                  <ProjectionChart
                    points={preview.p.days.map((d) => ({ date: d.date, balance: d.balance, inflow: d.inflow, outflow: d.outflow }))}
                    height={170}
                    highlightDate={preview.p.minDate}
                  />
                </div>
                <ul className="divide-y divide-line-soft border-t border-line-soft">
                  {preview.alerts.map((a) => (
                    <li key={a.fingerprint} className="flex items-center gap-3 px-4 py-2.5">
                      <SeverityTag severity={a.severity} />
                      <span className="truncate text-sm text-ink">{a.title}</span>
                    </li>
                  ))}
                </ul>
                <figcaption className="border-t border-line-soft px-4 py-2 text-2xs text-ink-3">
                  Calculado agora pelo mesmo motor da aplicação, sobre a empresa fictícia da demonstração.
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section aria-label="Confiança do produto" className="border-t border-line-soft bg-surface/40">
          <ul className="mx-auto grid max-w-6xl grid-cols-2 gap-x-5 gap-y-4 px-4 py-6 sm:grid-cols-4 sm:gap-x-6 sm:px-6">
            {[
              { icon: 'report', label: 'Cálculos auditáveis' },
              { icon: 'lock', label: 'Isolamento entre empresas' },
              { icon: 'eye', label: 'IA opcional e revisada' },
              { icon: 'signal', label: 'Só dados agregados vão à IA' },
            ].map(({ icon, label }) => (
              <li key={label} className="flex min-w-0 items-center gap-2.5">
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                  <Icon name={icon as 'report' | 'lock' | 'eye' | 'signal'} size={16} />
                </span>
                <span className="text-xs leading-snug font-medium text-ink-2 sm:text-sm">{label}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-y border-line-soft bg-surface/40">
          <div className="mx-auto grid max-w-6xl divide-y divide-line-soft px-4 sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-6">
            {[
              {
                icon: 'signal',
                q: 'O que está acontecendo com o dinheiro?',
                a: 'Saldo registrado, contas a pagar e a receber e vencidos em uma leitura só — cada número abre os lançamentos que o compõem.',
              },
              {
                icon: 'flow',
                q: 'O que pode acontecer nas próximas semanas?',
                a: 'Projeção de 7, 30 e 90 dias com cenários base, conservador e personalizado. Premissas sempre visíveis.',
              },
              {
                icon: 'alert',
                q: 'O que merece atenção — e o que fazer?',
                a: 'Alertas priorizados com evidências numéricas, período analisado, impacto estimado e próxima ação sugerida.',
              },
            ].map(({ icon, q, a }) => (
              <div key={q} className="px-0 py-8 sm:px-6 sm:py-12">
                <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-md bg-accent-soft text-accent">
                  <Icon name={icon as 'signal' | 'flow' | 'alert'} size={18} />
                </span>
                <p className="text-lg leading-snug font-semibold tracking-tight sm:text-xl">{q}</p>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">{a}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="como-funciona" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <p className="eyebrow mb-3">Como funciona</p>
          <h2 className="max-w-xl text-2xl font-semibold tracking-tight sm:text-3xl">Da planilha à decisão, sem fórmulas novas.</h2>
          <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: 'upload',
                t: 'Importe',
                d: 'CSV ou Excel com os nomes de coluna que você já usa. O sistema sugere o mapeamento e aponta cada linha com problema.',
              },
              {
                icon: 'report',
                t: 'Entenda',
                d: 'Indicadores com definição explícita. Resultado operacional não é apresentado como lucro contábil.',
              },
              {
                icon: 'calendar',
                t: 'Antecipe',
                d: 'Datas de saldo mínimo, semanas de pagamentos concentrados e recebimentos atrasados que afetam o caixa.',
              },
              {
                icon: 'sliders',
                t: 'Simule',
                d: 'Contratar, comprar, renegociar ou atrasar: compare o cenário atual com o alternativo antes de decidir.',
              },
            ].map(({ icon, t, d }, i) => (
              <li key={t} className="relative flex gap-4 lg:block">
                {i < 3 && <span aria-hidden="true" className="absolute top-10 -bottom-8 left-5 w-px bg-line-soft sm:hidden" />}
                {i < 3 && <span aria-hidden="true" className="absolute top-5 left-10 -right-8 hidden h-px bg-line-soft lg:block" />}
                <div className="num relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-bg shadow-lg shadow-accent/20 lg:mb-4">
                  {i + 1}
                </div>
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-base font-semibold">
                    <Icon name={icon as 'upload' | 'report' | 'calendar' | 'sliders'} size={16} className="text-accent" />
                    {t}
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-ink-2">{d}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-y border-line-soft bg-surface/40">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-2">
            <div>
              <p className="eyebrow mb-3">Princípios</p>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Conclusões que você consegue conferir.</h2>
              <p className="mt-4 text-sm leading-relaxed text-ink-2">
                Cálculos financeiros são determinísticos e testados. A IA, quando disponível, é opcional, roda sob demanda e só pode citar números que o sistema
                calculou — um revisor automático reprova análises que não batem com os dados.
              </p>
            </div>
            <ul className="grid gap-px overflow-hidden rounded-lg border border-line-soft bg-line-soft sm:grid-cols-2">
              {[
                ['Rastreável', 'Todo alerta lista os lançamentos que o sustentam.'],
                ['Premissas explícitas', 'Cenários usam atrasos e margens que você define, não probabilidades inventadas.'],
                ['Sem dados insuficientes disfarçados', 'Sem histórico, o sistema diz que não há base para comparação.'],
                ['Simulação isolada', 'Simular nunca altera seus lançamentos reais.'],
              ].map(([t, d]) => (
                <li key={t} className="bg-surface p-5">
                  <p className="text-sm font-semibold">{t}</p>
                  <p className="mt-1.5 text-sm text-ink-2">{d}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="seguranca">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <p className="eyebrow mb-3">Privacidade e segurança</p>
            <h2 className="max-w-xl text-2xl font-semibold tracking-tight sm:text-3xl">Seus números são seus.</h2>
            <div className="mt-8 grid gap-8 text-sm leading-relaxed text-ink-2 sm:grid-cols-3">
              <p>
                <strong className="block text-ink">Isolamento por empresa</strong>
                Na versão com contas, cada consulta é filtrada no próprio banco de dados por políticas de acesso por empresa — não apenas na tela.
              </p>
              <p>
                <strong className="block text-ink">Mínimo necessário</strong>
                Análises de IA recebem dados agregados, não sua base inteira. Seus dados não são usados para treinar modelos.
              </p>
              <p>
                <strong className="block text-ink">Demonstração local</strong>A demonstração roda no seu navegador com dados fictícios. Planilhas importadas
                nela não saem do seu computador.
              </p>
            </div>
            <p className="mt-8 text-xs text-ink-3">
              Estado atual: produto em desenvolvimento. Contas de usuário, banco de dados e análises por IA ainda não estão disponíveis; a demonstração está
              completa.
            </p>
          </div>
        </section>

        <section className="border-t border-line-soft bg-surface/40">
          <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6 sm:py-24">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Experimente com uma empresa fictícia.</h2>
            <p className="mx-auto mt-3 max-w-md text-sm text-ink-2">
              Edite lançamentos, importe uma planilha, abra alertas e simule decisões. Você pode reinicializar os dados quando quiser.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <ButtonLink to="/app/overview?modo=demo" variant="primary">
                Comece pela demonstração
              </ButtonLink>
              <ButtonLink to="/cadastro" variant="secondary">
                Criar conta
              </ButtonLink>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line-soft">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-xs text-ink-3 sm:px-6">
          <span>Nexo Finance · nome provisório</span>
          <span>Apoio à decisão. Não substitui contabilidade nem constitui recomendação financeira.</span>
        </div>
      </footer>
    </div>
  )
}
