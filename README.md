# Nexo Finance

> Veja o que vem antes do problema.

Inteligência financeira e apoio à decisão para pequenas empresas brasileiras. Nome provisório — verificar marca e domínio antes do lançamento comercial.

**Estado atual:** Fases 1 e 2 concluídas; Fase 3 (Supabase) implementada no código, **aguardando um projeto Supabase** para aplicar as migrations e rodar os testes de isolamento. Sem as variáveis do Supabase, a aplicação funciona inteira em modo de demonstração. IA ainda não conectada. Relatórios: [Fases 1–2](docs/RELATORIO-FASES-1-2.md), [Fase 3](docs/RELATORIO-FASE-3.md). Configuração: [docs/SUPABASE.md](docs/SUPABASE.md).

## Rodando

Requisitos: Node 20+ (testado com Node 24.22 / npm 11.19).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 174 testes unitários e de interface (Vitest)
npm run test:db    # 27 testes de isolamento/RLS contra um projeto Supabase de teste
npm run db:push    # aplica as migrations no projeto vinculado (Supabase CLI)
npm run build      # typecheck + build de produção em dist/
npm run preview    # serve o build em http://localhost:4173
```

Nenhuma variável de ambiente é necessária para o modo de demonstração. Para as fases seguintes, copie `.env.example` para `.env.local`.

## Rotas

| Rota                                      | Conteúdo                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                       | Página pública, com prévia calculada pelo motor real sobre dados fictícios                                                            |
| `/login`, `/cadastro`, `/redefinir-senha` | Supabase Auth (cadastro cria a empresa; recuperação por e-mail). Sem Supabase configurado, informam que o serviço não está disponível |
| `/app/overview`                           | Central de decisões: situação atual, o que merece atenção, próxima decisão, evolução                                                  |
| `/app/movimentacoes`                      | Lançamentos: busca (atalho `/`), filtros, paginação, criar/editar/excluir, histórico                                                  |
| `/app/fluxo-de-caixa`                     | Projeção 7/30/90 dias, cenários base/conservador/personalizado, premissas e rastreabilidade                                           |
| `/app/inteligencia`                       | Alertas com evidências, estados (novo/em análise/resolvido/ignorado), exemplo de análise + revisor                                    |
| `/app/simulador`                          | Decisões combinadas, comparação atual × alternativo, cenários salvos                                                                  |
| `/app/relatorios`                         | 6 relatórios com prévia, CSV e PDF (impressão)                                                                                        |
| `/app/importacoes`                        | Importação CSV/XLSX em etapas com mapeamento, validação, duplicatas e histórico                                                       |
| `/app/configuracoes`                      | Contas, categorias, limites de alertas, integrações, reinicializar demonstração, registro de ações                                    |

## Estrutura

```
src/
  lib/            dinheiro (centavos), datas (ISO, fuso SP), hooks utilitários
  domain/
    finance/      métricas, projeção, simulação, alertas — funções puras e testadas
    import/       CSV, XLSX (sem biblioteca), mapeamento e validação de linhas
    ai/           contrato de análise estruturada e revisor
    reports.ts    relatórios como dados tabulares
    transactions.ts  validação e visões de lançamentos
  data/           contrato de repositório, repositórios demo e Supabase, store React
  components/     UI, gráficos SVG, diálogos e toasts, ícones
  features/       uma pasta por página (carregadas sob demanda)
  app/            shell, navegação, onboarding, fallback, 404
supabase/
  migrations/     esquema, regras no servidor, RLS (versionados)
  tests/          isolamento entre empresas pela API pública
docs/             arquitetura, decisões e relatório das fases
```

Publicação: `netlify.toml` e `public/_redirects` já configurados (SPA + cabeçalhos de segurança e cache). Ainda não publicado.
