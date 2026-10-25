# Relatório — Fase 3 (dados e segurança)

Data: 24/10/2026. Decisão: Supabase hospedado agora; Supabase local fica para depois (a pasta `supabase/config.toml` já está pronta para `supabase start`).

## Arquivos criados ou alterados
**Banco** — `supabase/config.toml`, `supabase/migrations/20261024000100_core_schema.sql`, `…000200_rules_and_triggers.sql`, `…000300_rls.sql`.
**Testes** — `supabase/tests/isolation.test.ts`, `vitest.db.config.ts`, `src/data/supabaseMapping.test.ts`.
**App** — `src/lib/supabase.ts`, `src/data/supabaseRepository.ts`, `src/data/supabaseMapping.ts`, `src/features/auth/session.tsx`, `src/features/auth/AuthPage.tsx` (fluxos reais), `src/features/auth/ResetPasswordPage.tsx`, `src/app/Onboarding.tsx`, `src/app/AppShell.tsx` (escolha demo × empresa real, troca de empresa, sair), `src/App.tsx`, tratamento de erro em diálogos e páginas.
**Domínio** — identificador de origem distinto para linhas repetidas no mesmo arquivo (`#2`, `#3`), impressão digital curta dos alertas (hash dos ids).
**Docs** — `docs/SUPABASE.md`, `.env.example`, README.

## O que está implementado
- Esquema com UUID, NUMERIC(14,2), constraints e índices nas consultas frequentes. **FKs compostas `(id, company_id)`**: um lançamento não consegue apontar para conta, categoria ou importação de outra empresa nem manipulando a API.
- Regras no servidor: categoria × tipo, liquidação não futura (no fuso da empresa), transferência coerente, `company_id` imutável, autoria/origem não editáveis, idempotência de importação por índice único.
- **RLS em todas as tabelas**; papéis owner/admin/member/viewer; nada para `anon`; empresa só nasce via `create_company`; registro de ações escrito só por gatilhos.
- Importação atômica (`import_transactions`): tudo ou nada, limite de linhas lido de `plan_limits`.
- Preparação comercial real: `plan_limits` (membros, linhas por importação, empresas por usuário, análises de IA = 0) — os dois limites usados hoje são aplicados pelo banco.
- Autenticação: cadastro (cria a empresa), login, recuperação de senha por e-mail, perfil mínimo, onboarding para quem ainda não tem empresa, várias empresas por usuário com seletor.
- `SupabaseRepository` com o mesmo contrato do repositório de demonstração: as telas não mudaram. Paginação de 1.000 em 1.000, cache local atualizado após cada operação (sem recarregar a página), detecção de UPDATE/DELETE bloqueado por RLS (que não gera erro) e mensagens de erro sem detalhes internos.
- Demonstração e dados reais nunca se misturam: repositórios e armazenamentos diferentes; quem está autenticado pode abrir a demonstração e voltar.
- O SDK do Supabase (31 KB gzip) só é baixado quando há sessão ou ação de login. JS inicial: 82,6 KB gzip.

## Testes
- `npm test`: **174 passando** (16 novos: conversões NUMERIC ↔ centavos sem float, mapeamento, mensagens de erro, origem de linhas repetidas).
- `npm run test:db`: **27 testes escritos, NÃO executados** — dependem de um projeto Supabase de teste e das chaves em `.env.test.local`. Sem elas, a suíte é pulada (verificado).
- **As migrations ainda não foram executadas em nenhum banco.** Podem surgir erros de SQL na primeira aplicação; eu corrijo assim que rodar.
- Verificado no navegador sem Supabase configurado: landing → demonstração, recuperação de senha e `/redefinir-senha` informam corretamente a indisponibilidade; sem erros no console.

## Pendências externas
1. Criar o projeto Supabase e seguir [SUPABASE.md](SUPABASE.md) (auth, migrations, variáveis).
2. Passar `VITE_SUPABASE_URL` e a chave anon (podem ir em `.env.local`; são públicas por desenho).
3. Para `test:db`, colocar as três chaves de teste em `.env.test.local` — a service_role direto no arquivo, não no chat.

## Limitações conhecidas / próximos passos
- Os cálculos ainda rodam no navegador sobre todos os lançamentos da empresa (adequado para milhares; a Fase 4 move saldo, evolução e projeção-base para funções SQL).
- Convite de membros: o banco já permite (owner/admin); falta a tela.
- Editar saldo de abertura e nome da empresa: permitido pelo RLS para admin; falta a tela.
- Validação de importação ainda acontece no cliente; o banco reaplica as regras de integridade, mas uma Edge Function com limite de requisições fica para a Fase 4.
- Rate limiting de login/cadastro: o do próprio Supabase Auth (ajustável no painel).
