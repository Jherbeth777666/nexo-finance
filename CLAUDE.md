# Nexo Finance

SaaS de inteligência financeira para pequenas empresas brasileiras. React + TypeScript + Vite, Vitest, Supabase (Auth, Postgres com RLS). Sem variáveis do Supabase, roda inteiro em modo de demonstração.

Leia primeiro: `README.md` (rotas e estrutura), `docs/ARQUITETURA.md` (decisões), `docs/RELATORIO-FASE-3.md` (estado atual e pendências).

## Comandos

- Instalar: `npm ci`
- Testes: `npm test` (Vitest; 174 testes na importação para cá)
- Tipos: `npm run typecheck`
- Build: `npm run build`
- Testes de banco (precisam de um projeto Supabase de teste): `npm run test:db`

## Convenções

- Dinheiro sempre em centavos inteiros (`src/lib/money`); datas ISO no fuso de São Paulo (`src/lib/dates`).
- Regras de negócio são funções puras em `src/domain/`, sempre com testes.
- Acesso a dados só pelo contrato `src/data/repository.ts` (implementações demo e Supabase).
- Segredos nunca no código nem no chat: `.env.local` e `.env.test.local`, que o próprio usuário preenche.
