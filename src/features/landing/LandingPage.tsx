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
        <section className="mx-auto grid max-w-6xl gap-12 px-4 pt-14 pb-20 sm:px-6 lg:grid-cols-[1fr_1.1fr] lg:pt-24">
          <div>
            <p className="eyebrow mb-4">Inteligência financeira para pequenas empresas</p>
            <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.4rem]">Veja o que vem antes do problema.</h1>
            <p className="mt-6 max-w-lg text-base leading-relaxed text-ink-2 sm:text-lg">
              O Nexo lê seus lançamentos e planilhas, projeta o caixa das próximas semanas e mostra o que merece atenção — com os números e as premissas de cada conclusão.
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
          <figure className="overflow-hidden rounded-lg border border-line-soft bg-surface shadow-2xl shadow-black/40">
            <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
              <span className="text-xs text-ink-2">{preview.company}</span>
              <Tag tone="warn">dados fictícios</Tag>
            </div>
            <div className="grid grid-cols-3 gap-px bg-line-soft text-sm">
              <div className="bg-surface px-4 py-3">
                <p className="eyebrow">Saldo hoje</p>
                <Money value={preview.p.startBalance} className="mt-1 block text-base font-semibold" />
              </div>
              <div className="bg-surface px-4 py-3">
                <p className="eyebrow">Mínimo 30 dias</p>
                <Money value={preview.p.minBalance} tone="risk-only" className="mt-1 block text-base font-semibold" />
              </div>
              <div className="bg-surface px-4 py-3">
                <p className="eyebrow">Em {formatDateBR(preview.p.minDate).slice(0, 5)}</p>
                <span className="mt-1 block text-base font-semibold text-ink-2">dia mais apertado</span>
              </div>
            </div>
            <div className="px-3 pt-3">
              <ProjectionChart points={preview.p.days.map((d) => ({ date: d.date, balance: d.balance, inflow: d.inflow, outflow: d.outflow }))} height={170} highlightDate={preview.p.minDate} />
            </div>
            <ul className="divide-y divide-line-soft border-t border-line-soft">
              {preview.alerts.map((a) => (
                <li key={a.fingerprint} className="flex items-center gap-3 px-4 py-2.5">
                  <SeverityTag severity={a.severity} />
                  <span className="truncate text-sm text-ink">{a.title}</span>
                </li>
              ))}
            </ul>
            <figcaption className="border-t border-line-soft px-4 py-2 text-2xs text-ink-3">Calculado agora pelo mesmo motor da aplicação, sobre a empresa fictícia da demonstração.</figcaption>
          </figure>
        </section>

        <section className="border-y border-line-soft bg-surface/50">
          <div className="mx-auto grid max-w-6xl gap-px bg-line-soft sm:grid-cols-3">
            {[
              ['O que está acontecendo com o dinheiro?', 'Saldo registrado, contas a pagar e a receber e vencidos em uma leitura só — cada número abre os lançamentos que o compõem.'],
              ['O que pode acontecer nas próximas semanas?', 'Projeção de 7, 30 e 90 dias com cenários base, conservador e personalizado. Premissas sempre visíveis.'],
              ['O que merece atenção — e o que fazer?', 'Alertas priorizados com evidências numéricas, período analisado, impacto estimado e próxima ação sugerida.'],
            ].map(([q, a]) => (
              <div key={q} className="bg-bg px-6 py-10">
                <p className="text-lg leading-snug font-semibold tracking-tight">{q}</p>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">{a}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="como-funciona" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <p className="eyebrow mb-3">Como funciona</p>
          <h2 className="max-w-xl text-2xl font-semibold tracking-tight sm:text-3xl">Da planilha à decisão, sem fórmulas novas.</h2>
          <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Importe', 'CSV ou Excel com os nomes de coluna que você já usa. O sistema sugere o mapeamento e aponta cada linha com problema.'],
              ['Entenda', 'Indicadores com definição explícita. Resultado operacional não é apresentado como lucro contábil.'],
              ['Antecipe', 'Datas de saldo mínimo, semanas de pagamentos concentrados e recebimentos atrasados que afetam o caixa.'],
              ['Simule', 'Contratar, comprar, renegociar ou atrasar: compare o cenário atual com o alternativo antes de decidir.'],
            ].map(([t, d], i) => (
              <li key={t}>
                <span className="num text-sm text-ink-3">0{i + 1}</span>
                <p className="mt-2 font-semibold">{t}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{d}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-line-soft">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2">
            <div>
              <p className="eyebrow mb-3">Princípios</p>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Conclusões que você consegue conferir.</h2>
              <p className="mt-4 text-sm leading-relaxed text-ink-2">
                Cálculos financeiros são determinísticos e testados. A IA, quando disponível, é opcional, roda sob demanda e só pode citar números que o sistema calculou — um revisor automático
                reprova análises que não batem com os dados.
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

        <section id="seguranca" className="border-t border-line-soft bg-surface/50">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
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
                <strong className="block text-ink">Demonstração local</strong>
                A demonstração roda no seu navegador com dados fictícios. Planilhas importadas nela não saem do seu computador.
              </p>
            </div>
            <p className="mt-8 text-xs text-ink-3">
              Estado atual: produto em desenvolvimento. Contas de usuário, banco de dados e análises por IA ainda não estão disponíveis; a demonstração está completa.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Experimente com uma empresa fictícia.</h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-ink-2">Edite lançamentos, importe uma planilha, abra alertas e simule decisões. Você pode reinicializar os dados quando quiser.</p>
          <ButtonLink to="/app/overview?modo=demo" variant="primary" className="mt-6">
            Abrir demonstração
          </ButtonLink>
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
