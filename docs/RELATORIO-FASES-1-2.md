# Relatório — Fases 1 e 2

Data: 24/10/2026.

## Fase 1 — Inspeção e planejamento
- Diretório inicial **vazio** (sem código, sem git). Ambiente: Windows 11, Node 24.22, npm 11.19, Git 2.55.
- Decisões: React + TS + Vite + Tailwind 4; sem biblioteca de componentes nem de gráficos (componentes sobre elementos nativos, gráficos SVG próprios); Supabase para Auth/Postgres/RLS na Fase 3; **sem FastAPI** por enquanto — nenhum processamento hoje justifica um serviço separado (reavaliar na Fase 5 se a orquestração de IA exigir).
- Riscos registrados: (1) dados de demo em `localStorage` — aceitável só para dados fictícios; (2) validação hoje só no cliente — precisa ser repetida no banco; (3) projeções dependem do que foi lançado: vendas futuras não registradas fazem o horizonte de 90 dias parecer pior do que é — mitigado com aviso de cobertura e premissa de receita semanal estimada; (4) leitura de XLSX no navegador — mover para Edge Function na Fase 3.
- Detalhes em [ARQUITETURA.md](ARQUITETURA.md).

## Fase 2 — Fundação visual (entregue além do pedido mínimo)
Foram adiantados o motor financeiro, a importação e o contrato de IA porque a demonstração precisava de números calculados de verdade, não decorativos. Nada disso depende de credenciais.

### O que funciona
- Identidade visual própria (dark executive, tokens de cor com significado, Inter com números tabulares, faixa de leitura em vez de grade de cards, barra de severidade nos alertas).
- Shell responsivo: barra lateral no desktop, gaveta + barra inferior no celular, link "pular para o conteúdo", foco visível, navegação por teclado, títulos de página.
- Todas as 10 rotas do app + landing, login e cadastro, 404.
- Visão geral organizada nas 4 áreas pedidas (situação atual, atenção, próxima decisão com controle interativo, evolução); todo indicador tem definição, período e link para os lançamentos que o compõem.
- Movimentações: CRUD com validação, confirmação de exclusão, histórico por lançamento, busca com debounce, filtros por período/tipo/situação/categoria, paginação.
- Fluxo de caixa: 7/30/90 dias, 3 cenários, premissas explícitas, valores excluídos informados, dias de pressão, tabela de rastreabilidade com saldo acumulado.
- Inteligência: 7 regras de alerta, estados persistentes, limites configuráveis, "dados insuficientes" quando aplicável, exemplo de análise **identificado como regra local** e revisor automático.
- Simulador: 7 tipos de decisão combináveis, mesmo motor, nenhum lançamento real alterado, cenários salvos.
- Relatórios: 6 tipos com prévia, CSV (com proteção contra injeção de fórmulas) e PDF via impressão.
- Importação CSV/XLSX completa em 4 etapas, com idempotência e histórico.
- Modo de demonstração isolado, identificado em todas as telas, reinicializável.

### O que NÃO está pronto (não simulado na interface)
- Login/cadastro/recuperação: formulários validam, mas informam que o serviço não está configurado. Fase 3.
- Supabase, migrations, RLS e testes de isolamento entre empresas: **não executados** — não há projeto Supabase nem credenciais. Esquema planejado em ARQUITETURA.md.
- IA: nenhum provedor. Fase 5.
- Publicação no Netlify: configuração pronta (`netlify.toml`), **não publicado**.

## Testes executados (`npm test`)
158 testes, 8 arquivos, todos passando:
- `lib/money.test.ts` (49): parsing de valores BR/internacionais, rejeições, arredondamento, datas BR/ISO/serial Excel, fuso de São Paulo.
- `domain/finance/finance.test.ts` (37): saldo, transferências, caixa × competência, pagos × pendentes, atraso, projeção e cenários, simulador (inclusive não mutação), 9 cenários de alerta incluindo negativos.
- `domain/import/import.dom.test.ts` (22): CSV, codificação, limites, binário, mapeamento, erros por linha, reimportação, duplicatas suspeitas, XLSX real (ZIP montado no teste).
- `data/demo/seed.test.ts` (24): determinismo e cobertura das situações em 4 datas diferentes.
- `data/demoRepository.test.ts` (13): CRUD + auditoria, cópia defensiva, armazenamento corrompido/bloqueado, validação de lançamentos.
- `domain/ai/analysis.test.ts` (4): revisor aprova fatos e reprova valores inventados, falta de limitações e resposta vazia de provedor.
- `app/app.dom.test.tsx` (8): navegação, redirecionamento, 404, estado de erro com "tentar novamente", formulário de lançamento, login sem sucesso simulado.
- `domain/finance/perf.test.ts` (1): orçamento de tempo com 10.350 lançamentos.

Verificação manual no navegador (dev server): todas as rotas em 1440×900 e 375×812, sem erros no console e sem rolagem horizontal; importação → reimportação do mesmo arquivo (3 linhas desmarcadas automaticamente); criação de lançamento; simulador com contratação + equipamento parcelado.

**Não executados:** testes de permissão por empresa (dependem da Fase 3); testes de falha de API de IA reais (Fase 5 — só o revisor foi testado); Lighthouse.

## Performance
- **JS inicial: 79,9 KB gzip** (React + Router + shell), meta era ~200 KB. Cada página é um chunk de 3–5,5 KB gzip; alertas/seed 10 KB; leitor XLSX 1,7 KB carregado só ao importar .xlsx. CSS: 8,3 KB gzip.
- Fonte: só o subconjunto latino (48 KB) é baixado, `font-display: swap`.
- Medido no build de produção servido localmente: CLS 0,0006. LCP não pôde ser lido no painel embutido; **Lighthouse não foi executado** — pendente para quando houver URL publicada (medir com rede lenta).
- Motor com 10.350 lançamentos: projeção 90 dias 3,5 ms, alertas ~116 ms, evolução mensal 6 ms. Cálculos memoizados por mudança de dados; nenhuma chamada de IA na renderização.
- Gargalo conhecido: alertas recalculam tudo a cada mudança (~0,1 s em 10 mil lançamentos). Na Fase 3, mover agregações para SQL e armazenar alertas com estado.

## Dependências
Runtime: `react`, `react-dom`, `react-router`, `@fontsource-variable/inter`. Dev: Vite, plugin React, Tailwind, TypeScript, Vitest, jsdom, Testing Library.
`npm audit --omit=dev`: 0 vulnerabilidades. Restam avisos em dependências **só de teste** (`tinypool`, `@vitest/mocker`) cuja correção exige Vitest 4 (major) — avaliar na próxima fase.

## Configurações externas pendentes
1. Criar projeto Supabase → `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` em `.env.local` e no Netlify.
2. Conta Netlify conectada ao repositório (build `npm run build`, publish `dist`).
3. Provedor de IA (Fase 5): chave só como variável de servidor, nunca `VITE_`.
4. Verificação de marca/domínio para "Nexo Finance".

## Próximos passos (Fase 3)
1. `supabase init`, migrations versionadas do esquema em ARQUITETURA.md, RLS em todas as tabelas.
2. Testes de isolamento: dois usuários/duas empresas, `select/update/delete` cruzados via cliente Supabase devem falhar.
3. `SupabaseRepository` implementando `FinanceRepository`; Auth (cadastro, login, recuperação, perfil, criação de empresa, papéis).
4. Constraints e validação de lançamentos no banco; importação via Edge Function com limite de requisições.
5. Agregações em SQL (saldo, evolução, projeção-base) com índices.
